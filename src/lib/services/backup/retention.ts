import { readdir, stat } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { writeAudit } from "@/lib/domain/audit";
import { backupObjectKey } from "./runner";
import { createAdapter, type AdapterRow } from "./factory";
import { removeStagingFile } from "./dump";

/**
 * 备份保留策略（规格 16.11.3「保留策略」）。
 *
 * 之前 `backup_policies.retention_json` 只是个被读取展示的配置：
 * 策略页写着「每日 7 / 每周 4 / 每月 6」，但没有任何代码删过一份备份，
 * 磁盘只增不减（本机一个月就积了 51 个 `.zmbk`）。
 *
 * 这里实现的是标准 GFS（grandfather-father-son）三档：
 * - **daily**：最近 N 个「日期桶」里各留最新一份；
 * - **weekly**：最近 N 个「ISO 周桶」里各留最新一份；
 * - **monthly**：最近 N 个「月份桶」里各留最新一份。
 *
 * 三档取**并集**保留，其余删除。这样「每天一份、每周留一份、每月留一份」
 * 的直觉成立，而且不会因为某天多跑了几次手动备份就把历史挤掉。
 *
 * 两个刻意的取舍：
 * 1. **分桶按 UTC 日期**，不按策略时区。备份 cron 是 `0 3 * * *` Asia/Shanghai
 *    （= 19:00 UTC 前一天），按 UTC 分桶依然一天一份；用 UTC 是为了让
 *    「同一份数据在不同机器上算出同样的保留结果」，纯函数也才好写单测。
 * 2. **只删文件，不删作业记录**。`backup_jobs` 是审计凭据，删掉就再也说不清
 *    「某天到底有没有备份成功」。删除后写 `purged_at` 并清空 `local_path`，
 *    重跑时自动跳过，幂等。
 */

export interface RetentionConfig {
  daily: number;
  weekly: number;
  monthly: number;
}

/** 与 `backup_policies.retention_json` 的库默认值保持一致。 */
export const DEFAULT_RETENTION: RetentionConfig = { daily: 7, weekly: 4, monthly: 6 };

export interface RetentionCandidate {
  backupId: string;
  createdAt: Date;
}

export type RetentionRule = "daily" | "weekly" | "monthly" | "newest";

export interface RetentionPlan {
  keep: Array<{ backupId: string; rule: RetentionRule }>;
  purge: string[];
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.trunc(n);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

/**
 * 把 `retention_json` 归一成可用配置。
 *
 * 库里是 Json 列，历史行可能是 `null`、缺字段、甚至是字符串数字
 * （早期手写 SQL 塞进去的），所以这里不能直接信它的形状。
 */
export function normalizeRetention(raw: unknown): RetentionConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    daily: clamp(source.daily, 1, 365, DEFAULT_RETENTION.daily),
    weekly: clamp(source.weekly, 0, 104, DEFAULT_RETENTION.weekly),
    monthly: clamp(source.monthly, 0, 120, DEFAULT_RETENTION.monthly),
  };
}

/** UTC 日期桶，形如 `2026-11-03`。 */
export function dayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC 月份桶，形如 `2026-11`。 */
export function monthBucket(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * ISO 8601 周桶，形如 `2026-W45`。
 *
 * 规则：周一为一周第一天；第 1 周是包含 1 月 4 日的那一周。
 * 实现方式是「移到本周周四」再和「1 月 4 日所在周的周四」相减——
 * 周四属于哪一年，这一周就属于哪一年，跨年周不会算错。
 */
export function weekBucket(date: Date): string {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const mondayOffset = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - mondayOffset + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstOffset = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstOffset + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 纯函数：给定候选备份与保留配置，算出「留哪些、删哪些」。
 *
 * 抽成纯函数是为了让「保留策略到底删了什么」可以被单测钉死，
 * 而不是只能等生产环境跑一个月再看磁盘。
 */
export function planRetention(candidates: RetentionCandidate[], retention: RetentionConfig): RetentionPlan {
  const sorted = [...candidates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (sorted.length === 0) return { keep: [], purge: [] };

  const kept = new Map<string, RetentionRule>();

  const takeBuckets = (limit: number, keyOf: (d: Date) => string, rule: RetentionRule) => {
    if (limit <= 0) return;
    const seen = new Set<string>();
    for (const candidate of sorted) {
      if (seen.size >= limit) break;
      const key = keyOf(candidate.createdAt);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!kept.has(candidate.backupId)) kept.set(candidate.backupId, rule);
    }
  };

  takeBuckets(retention.daily, dayBucket, "daily");
  takeBuckets(retention.weekly, weekBucket, "weekly");
  takeBuckets(retention.monthly, monthBucket, "monthly");

  // 兜底：无论配置多小，最新一份永远不删。
  if (!kept.has(sorted[0].backupId)) kept.set(sorted[0].backupId, "newest");

  // 去重：`backup_id` 在库里是唯一索引，正常不会重复；
  // 但计划是纯函数，输入来自一次查询结果，不该让重复行变成重复删除/重复保留。
  const keep = [...kept.entries()].map(([backupId, rule]) => ({ backupId, rule }));
  const keepIds = new Set(keep.map((item) => item.backupId));
  const purge = [...new Set(sorted.map((candidate) => candidate.backupId).filter((id) => !keepIds.has(id)))];

  return { keep, purge };
}

/** 远端「对象本来就不存在」的常见表现，按成功处理，避免每次都重试同一个空对象。 */
function isMissingObject(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not\s*found|no\s*such\s*file|ENOENT|does not exist/i.test(message);
}

export interface RetentionPurgedItem {
  backupId: string;
  localDeleted: boolean;
  remoteDeleted: number;
  remoteFailed: string[];
}

export interface RetentionSummary {
  policyId: string;
  policyName: string;
  retention: RetentionConfig;
  /** 参与评估的作业数（已清理过的不会再进来）。 */
  evaluated: number;
  kept: number;
  purged: number;
  /** 远端删除失败、留待下轮重试的数量。 */
  failed: number;
  items: RetentionPurgedItem[];
}

/**
 * 对一条策略执行保留清理：算计划 → 删本地暂存 → 删每个已验证目标上的远端对象
 * → 全成功才写 `purged_at`（部分失败留待下轮重试，不会静默丢账）。
 */
export async function applyRetention(input: {
  organizationId: string;
  policyId: string;
  actorId?: string | null;
  dryRun?: boolean;
}): Promise<RetentionSummary> {
  const policy = await prisma.backup_policies.findFirst({
    where: { id: input.policyId, organization_id: input.organizationId },
    select: { id: true, name: true, retention_json: true },
  });
  if (!policy) throw new Error("备份策略不存在");

  const retention = normalizeRetention(policy.retention_json);

  const jobs = await prisma.backup_jobs.findMany({
    where: {
      organization_id: input.organizationId,
      policy_id: policy.id,
      status: { in: ["succeeded", "partial", "degraded"] },
      purged_at: null,
    },
    select: {
      id: true,
      backup_id: true,
      created_at: true,
      local_path: true,
      backup_job_targets: {
        where: { status: "verified" },
        select: {
          destination_id: true,
          backup_storage_destinations: true,
        },
      },
    },
    orderBy: { created_at: "desc" },
  });

  const plan = planRetention(
    jobs.map((job) => ({ backupId: job.backup_id, createdAt: job.created_at })),
    retention,
  );

  const summary: RetentionSummary = {
    policyId: policy.id,
    policyName: policy.name,
    retention,
    evaluated: jobs.length,
    kept: plan.keep.length,
    purged: 0,
    failed: 0,
    items: [],
  };

  if (input.dryRun || plan.purge.length === 0) return summary;

  const byBackupId = new Map(jobs.map((job) => [job.backup_id, job]));

  for (const backupId of plan.purge) {
    const job = byBackupId.get(backupId);
    if (!job) continue;

    const item: RetentionPurgedItem = { backupId, localDeleted: false, remoteDeleted: 0, remoteFailed: [] };

    if (job.local_path) {
      try {
        await removeStagingFile(job.local_path);
        item.localDeleted = true;
      } catch (error) {
        item.remoteFailed.push(`本地暂存：${(error as Error).message}`);
      }
    } else {
      item.localDeleted = true;
    }

    for (const target of job.backup_job_targets) {
      const row = target.backup_storage_destinations as unknown as AdapterRow | null;
      if (!row) continue;
      try {
        const adapter = await createAdapter(row, input.organizationId);
        await adapter.remove(backupObjectKey(row.remote_prefix, backupId));
        item.remoteDeleted += 1;
      } catch (error) {
        if (isMissingObject(error)) {
          item.remoteDeleted += 1;
        } else {
          item.remoteFailed.push(`${row.id}：${(error as Error).message.slice(0, 200)}`);
        }
      }
    }

    if (item.remoteFailed.length === 0) {
      await prisma.backup_jobs.update({
        where: { id: job.id },
        data: { purged_at: new Date(), local_path: null },
      });
      summary.purged += 1;
    } else {
      summary.failed += 1;
    }
    summary.items.push(item);
  }

  await writeAudit({
    organizationId: input.organizationId,
    actorType: input.actorId ? "admin" : "system",
    actorId: input.actorId ?? null,
    action: "backup.retention_purge",
    resourceType: "backup_policy",
    resourceId: policy.id,
    after: {
      policy: policy.name,
      retention,
      evaluated: summary.evaluated,
      kept: summary.kept,
      purged: summary.purged,
      failed: summary.failed,
      purged_backups: summary.items.map((item) => item.backupId),
    },
  });

  return summary;
}

/** 对所有启用的策略跑一遍（供手动触发端点与排障脚本复用）。 */
export async function applyRetentionForOrganization(input: {
  organizationId: string;
  actorId?: string | null;
  dryRun?: boolean;
}): Promise<RetentionSummary[]> {
  const policies = await prisma.backup_policies.findMany({
    where: { organization_id: input.organizationId, enabled: true },
    select: { id: true },
    orderBy: { created_at: "asc" },
  });
  const results: RetentionSummary[] = [];
  for (const policy of policies) {
    results.push(
      await applyRetention({
        organizationId: input.organizationId,
        policyId: policy.id,
        actorId: input.actorId ?? null,
        dryRun: input.dryRun,
      }),
    );
  }
  return results;
}

/**
 * 暂存目录清扫（保留策略的另一半）。
 *
 * 策略保留只管「挂在策略上、且跑成功过」的作业。实际磁盘上还有两类文件永远
 * 不会被它碰到，本机实测 21 个 `.zmbk` 里有 16 个属于这类：
 *
 * 1. **孤儿文件**——目录里有 `.zmbk`，但 `backup_jobs` 里已经没有对应行
 *    （早期 smoke 测试留下的、或作业行被删掉但文件没删）。策略根本看不见它们。
 * 2. **失败作业的暂存文件**——`status='failed'` 的作业会被保留策略的
 *    `status in (succeeded,partial,degraded)` 过滤掉，于是文件永久滞留。
 *
 * 第二类不能立刻删：`retryJobTarget()` 正是靠 `local_path` + `manifest_sha256`
 * 把已经 dump 好的内容重传到修好的目标上，立刻删会让「改完配置重试」失效。
 * 所以给一个宽限期（默认 7 天），过期后连重试窗口都过了，才清掉。
 */

export interface StagingSweepEntry {
  backupId: string;
  /** 文件 mtime；孤儿文件没有作业行，只能用它判断年龄。 */
  modifiedAt: Date;
  job: { status: string; purgedAt: Date | null } | null;
}

export interface StagingSweepPlan {
  delete: string[];
  keep: string[];
}

/**
 * 两档宽限期，别合成一个：
 * - `orphanMs`：孤儿文件没有作业行引用，按定义就没有重传价值，只防「刚被拷进来还没登记」的一小段窗口；
 * - `failedMs`：失败作业的暂存文件是 `retryJobTarget()` 的唯一素材，必须给足重试窗口。
 * 用一个统一值的话，要么孤儿占盘太久，要么把重试窗口压没。
 */
export interface StagingGrace {
  orphanMs: number;
  failedMs: number;
}

/** 纯函数：判定每个暂存文件该不该删。 */
export function planStagingSweep(entries: StagingSweepEntry[], now: Date, grace: StagingGrace): StagingSweepPlan {
  const del: string[] = [];
  const keep: string[] = [];
  for (const entry of entries) {
    const ageMs = now.getTime() - entry.modifiedAt.getTime();

    if (!entry.job) {
      // 孤儿：没有作业行引用，过了登记窗口就没有任何恢复价值。
      (ageMs >= grace.orphanMs ? del : keep).push(entry.backupId);
      continue;
    }
    if (entry.job.purgedAt) {
      // 保留策略已经清过一次，文件却又出现（手工拷回、恢复演练残留）——直接清。
      del.push(entry.backupId);
      continue;
    }
    if (entry.job.status === "failed") {
      (ageMs >= grace.failedMs ? del : keep).push(entry.backupId);
      continue;
    }
    if (entry.job.status === "running" || entry.job.status === "queued") {
      keep.push(entry.backupId);
      continue;
    }
    // succeeded / partial / degraded 且未 purged：策略要留的，绝不动。
    keep.push(entry.backupId);
  }
  return { delete: del, keep };
}

export interface StagingSweepSummary {
  scanned: number;
  deleted: number;
  kept: number;
  bytesFreed: number;
  dryRun: boolean;
  deletedIds: string[];
}

/** 扫描 `config.backupLocalDir` 顶层 `.zmbk`，按上面的规则清理。 */
export async function sweepStagingFiles(input: {
  organizationId: string;
  actorId?: string | null;
  dryRun?: boolean;
  /** 孤儿文件的宽限期（小时），默认 1 小时。 */
  orphanGraceHours?: number;
  /** 失败作业的宽限期（天），默认 7 天 —— 与运维习惯的「一周内可重传」对齐。 */
  failedGraceDays?: number;
  now?: Date;
}): Promise<StagingSweepSummary> {
  const now = input.now ?? new Date();
  const grace: StagingGrace = {
    orphanMs: Math.max(0, input.orphanGraceHours ?? 1) * 3_600_000,
    failedMs: Math.max(1, input.failedGraceDays ?? 7) * 86_400_000,
  };
  const dryRun = input.dryRun ?? false;
  const dir = config.backupLocalDir;

  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".zmbk"));
  } catch {
    // 目录还不存在（从没备份过），没有可清扫的东西。
    return { scanned: 0, deleted: 0, kept: 0, bytesFreed: 0, dryRun, deletedIds: [] };
  }

  const entries: Array<StagingSweepEntry & { sizeBytes: number }> = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    entries.push({
      backupId: name.slice(0, -".zmbk".length),
      modifiedAt: info.mtime,
      job: null,
      sizeBytes: info.size,
    });
  }

  const ids = entries.map((entry) => entry.backupId);
  const jobs = ids.length
    ? await prisma.backup_jobs.findMany({
        where: { organization_id: input.organizationId, backup_id: { in: ids } },
        select: { backup_id: true, status: true, purged_at: true },
      })
    : [];
  const byId = new Map(jobs.map((job) => [job.backup_id, { status: job.status, purgedAt: job.purged_at }]));
  for (const entry of entries) entry.job = byId.get(entry.backupId) ?? null;

  const plan = planStagingSweep(entries, now, grace);
  const summary: StagingSweepSummary = {
    scanned: entries.length,
    deleted: 0,
    kept: plan.keep.length,
    bytesFreed: 0,
    dryRun,
    deletedIds: [],
  };
  if (dryRun) {
    // dry-run 的 deleted 要报「本来会删多少」，否则演练看不出任何信息。
    summary.deleted = plan.delete.length;
    summary.deletedIds = plan.delete;
    return summary;
  }

  const sizeById = new Map(entries.map((entry) => [entry.backupId, entry.sizeBytes]));
  for (const backupId of plan.delete) {
    try {
      await removeStagingFile(`${dir}/${backupId}.zmbk`);
      summary.deleted += 1;
      summary.bytesFreed += sizeById.get(backupId) ?? 0;
      summary.deletedIds.push(backupId);
      // 孤儿文件没有作业行可标；有作业行的顺手把 local_path 置空，避免重试指向已删文件。
      await prisma.backup_jobs.updateMany({
        where: { organization_id: input.organizationId, backup_id: backupId, local_path: { not: null } },
        data: { local_path: null },
      });
    } catch (error) {
      console.error("[backup] 清扫暂存文件失败", { backupId, error });
    }
  }

  if (summary.deleted > 0) {
    await writeAudit({
      organizationId: input.organizationId,
      actorType: input.actorId ? "admin" : "system",
      actorId: input.actorId ?? null,
      action: "backup.staging_sweep",
      resourceType: "backup_job",
      resourceId: null,
      after: {
        scanned: summary.scanned,
        deleted: summary.deleted,
        kept: summary.kept,
        bytes_freed: summary.bytesFreed,
        orphan_grace_hours: Math.round(grace.orphanMs / 3_600_000),
        failed_grace_days: Math.round(grace.failedMs / 86_400_000),
        deleted_ids: summary.deletedIds.slice(0, 50),
      },
    });
  }

  return summary;
}
