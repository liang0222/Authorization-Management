import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { encryptBackup, sha256Hex } from "./crypto";
import { pgDump, restoreIntoScratch } from "./pg";
import { writeStagingFile, readStagingFile } from "./dump";
import { createAdapter, type AdapterRow } from "./factory";
import type { StorageAdapter } from "./types";
import { writeAudit } from "@/lib/domain/audit";
import { notifyBackupIssue } from "./alerts";

/**
 * 备份作业编排（规格 16.11.3 的多目标策略就在 `decideJobStatus` 里）。
 *
 * 设计上的两个坚持：
 * 1. 每个目标单独记录状态与错误，绝不因为一个目标成功就把整次备份标成功；
 * 2. 「上传成功」不等于「备份可用」——必须下载回来比对 SHA-256 才算 verified。
 */
export interface RunBackupInput {
  organizationId: string;
  userId: string | null;
  policyId?: string | null;
  trigger?: string;
  /** 只跑指定目标（用于重传单个目标）。 */
  onlyDestinationId?: string | null;
}

export interface RunBackupResult {
  jobId: string;
  backupId: string;
  status: "succeeded" | "partial" | "degraded" | "failed";
  sizeBytes: number;
  manifestSha256: string;
  targets: Array<{ destinationId: string; name: string; status: string; error?: string | null }>;
}

export const BACKUP_ID_PREFIX = "bkp_";

export function newBackupId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${BACKUP_ID_PREFIX}${stamp}_${randomBytes(3).toString("hex")}`;
}

/**
 * 备份对象在存储上的键：`<remote_prefix>/<backupId>.zmbk`。
 *
 * 这是「谁负责前缀」的唯一权威：**remote_prefix 由这里拼**，
 * 适配器只负责再补上自己的 root_path（SFTP 的 /upload、WebDAV 的目录、S3 的 bucket 隐含）。
 *
 * 以前适配器工厂也把 remote_prefix 拼进 prefix 传下去，两边各拼一次，
 * SFTP 上的真实路径就变成了 `/upload/backups/offsite/backups/offsite/bkp_x.zmbk`。
 * 抽成一个函数是为了让「拼几次」这件事只有一个答案，重试路径也复用同一份。
 */
export function backupObjectKey(remotePrefix: string | null | undefined, backupId: string): string {
  // 三重归一：去首尾斜杠、折叠中间连续斜杠、丢弃空段。
  // 用户填 `//backups//offsite//` 这种写法在 S3 上会生成两个空对象名层级，
  // 在 SFTP 上会变成字面量空目录，两边都不是他想要的。
  const prefix = (remotePrefix ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return prefix ? `${prefix}/${backupId}.zmbk` : `${backupId}.zmbk`;
}

interface TargetPlan {
  destinationId: string;
  name: string;
  priority: number;
  isRequired: boolean;
  row: AdapterRow;
}

async function loadTargets(input: RunBackupInput, policyId: string | null): Promise<TargetPlan[]> {
  if (policyId) {
    const links = await prisma.backup_policy_targets.findMany({
      where: { policy_id: policyId, organization_id: input.organizationId },
      include: { backup_storage_destinations: true },
      orderBy: [{ priority: "asc" }],
    });
    return links
      .filter((link) => link.backup_storage_destinations.enabled)
      .map((link) => ({
        destinationId: link.destination_id,
        name: link.backup_storage_destinations.name,
        priority: link.priority,
        isRequired: link.is_required,
        row: link.backup_storage_destinations as unknown as AdapterRow,
      }));
  }

  const destinations = await prisma.backup_storage_destinations.findMany({
    where: { organization_id: input.organizationId, enabled: true },
    orderBy: [{ priority: "asc" }],
  });
  return destinations.map((row) => ({
    destinationId: row.id,
    name: row.name,
    priority: row.priority,
    isRequired: row.is_required,
    row: row as unknown as AdapterRow,
  }));
}

/** 目标模式判定：这是「多目标备份」里最容易做错的一段。 */
export function decideJobStatus(
  mode: "all_required" | "primary_then_fallback" | "quorum",
  results: Array<{ isRequired: boolean; ok: boolean; priority: number }>,
  requiredSuccessCount?: number | null,
): "succeeded" | "partial" | "degraded" | "failed" {
  const required = results.filter((item) => item.isRequired);
  const requiredOk = required.filter((item) => item.ok);
  const anyOk = results.some((item) => item.ok);

  if (mode === "all_required") {
    if (required.length > 0) return requiredOk.length === required.length ? "succeeded" : anyOk ? "partial" : "failed";
    return anyOk ? "succeeded" : "failed";
  }

  if (mode === "primary_then_fallback") {
    const sorted = [...results].sort((a, b) => a.priority - b.priority);
    const primary = sorted[0];
    if (!primary) return "failed";
    if (primary.ok) return "succeeded";
    // 主目标失败、备用成功：明确标 degraded，绝不假装主目标成功。
    return anyOk ? "degraded" : "failed";
  }

  const need = requiredSuccessCount ?? Math.max(1, Math.ceil(results.length / 2));
  const okCount = results.filter((item) => item.ok).length;
  if (okCount === results.length) return "succeeded";
  return okCount >= need ? "partial" : "failed";
}

/**
 * 判断一次上传失败是否值得重试。
 *
 * 只重试「链路抖动」这一类：超时、连接被重置、DNS 临时失败。
 * 明确的服务端拒绝（401/403/404/405/校验和不符）重试只会重复失败，
 * 还会把作业拖到超时，所以一律不重试。
 */
export function isTransientUploadError(message: string): boolean {
  return /aborted due to timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|fetch failed/i.test(
    message,
  );
}

/** 上传尝试次数上限（含首次）。1 次重试 = 对偶发抖动够用，又不至于把作业拖长到失控。 */
export const UPLOAD_ATTEMPTS = 2;

async function uploadToTarget(
  jobId: string,
  organizationId: string,
  plan: TargetPlan,
  backupId: string,
  body: Buffer,
  sha256: string,
): Promise<{ ok: boolean; error: string | null }> {
  const target = await prisma.backup_job_targets.create({
    data: {
      organization_id: organizationId,
      job_id: jobId,
      destination_id: plan.destinationId,
      status: "uploading",
    },
  });

  let adapter: StorageAdapter;
  try {
    adapter = await createAdapter(plan.row, organizationId);
  } catch (error) {
    const message = (error as Error).message;
    await prisma.backup_job_targets.update({
      where: { id: target.id },
      data: { status: "failed", error_code: "ADAPTER_INIT_FAILED", error_message: message.slice(0, 400) },
    });
    return { ok: false, error: message };
  }

  const remotePath = backupObjectKey(plan.row.remote_prefix, backupId);

  // 上传 + 回读校验。链路抖动（超时、连接重置）值得再试一次：
  // 2026-11-04 03:00 那次定时备份就是公网 WebDAV 单目标超时，另外四个目标全 verified。
  // 重试次数写死 2，不做指数退避——作业本身有 30 分钟总超时，退避在这里收益不大。
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const put = await adapter.put(remotePath, body);
      await prisma.backup_job_targets.update({
        where: { id: target.id },
        data: {
          status: "verifying",
          remote_uri: put.remoteUri,
          remote_size_bytes: BigInt(put.sizeBytes),
          checksum_sha256: sha256,
          uploaded_at: new Date(),
        },
      });

      // 下载回来自己算一遍：远端声明的 checksum 不可信，只有自己算的才算。
      const fetched = await adapter.get(remotePath);
      const actual = sha256Hex(fetched.body);
      const verified = actual === sha256;
      await prisma.backup_job_targets.update({
        where: { id: target.id },
        data: {
          status: verified ? "verified" : "failed",
          verified_at: verified ? new Date() : null,
          error_code: verified ? null : "CHECKSUM_MISMATCH",
          error_message: verified ? null : `远端 SHA-256 为 ${actual}`,
        },
      });
      return { ok: verified, error: verified ? null : "远端内容与本地不一致" };
    } catch (error) {
      const message = (error as Error).message;
      const lastAttempt = attempt >= UPLOAD_ATTEMPTS;
      const retryable = isTransientUploadError(message);
      if (!retryable || lastAttempt) {
        await prisma.backup_job_targets.update({
          where: { id: target.id },
          data: {
            status: "failed",
            error_code: "UPLOAD_FAILED",
            error_message: message.slice(0, 400),
            retry_count: { increment: 1 },
          },
        });
        return { ok: false, error: message };
      }
      // 记一次重试，但状态留在 uploading：此刻既不是失败也不是完成。
      await prisma.backup_job_targets.update({
        where: { id: target.id },
        data: { retry_count: { increment: 1 } },
      });
      console.warn("[backup] 上传失败，准备重试", {
        backupId,
        destination: plan.name,
        attempt,
        error: message,
      });
    }
  }

  // 循环必然在内部 return，这里只是让类型收窄。
  return { ok: false, error: "上传重试耗尽" };
}

export async function runBackup(input: RunBackupInput): Promise<RunBackupResult> {
  const policyId = input.policyId ?? null;
  const policy = policyId
    ? await prisma.backup_policies.findFirst({ where: { id: policyId, organization_id: input.organizationId } })
    : null;

  const plans = (await loadTargets(input, policyId)).filter((plan) =>
    input.onlyDestinationId ? plan.destinationId === input.onlyDestinationId : true,
  );
  if (plans.length === 0) {
    throw new Error("没有可用的备份目标：请先在「存储目标」里添加并启用至少一个目标");
  }

  const backupId = newBackupId();
  const job = await prisma.backup_jobs.create({
    data: {
      organization_id: input.organizationId,
      policy_id: policyId,
      backup_id: backupId,
      status: "running",
      trigger: input.trigger ?? "manual",
      started_at: new Date(),
      created_by: input.userId,
    },
  });

  const targetResults: RunBackupResult["targets"] = [];
  try {
    const dump = await pgDump();
    const encrypted = encryptBackup(dump.buffer);
    const staging = await writeStagingFile(backupId, encrypted.body);

    await prisma.backup_jobs.update({
      where: { id: job.id },
      data: {
        size_bytes: BigInt(staging.sizeBytes),
        local_path: staging.path,
        manifest_sha256: encrypted.sha256,
      },
    });

    const outcomes: Array<{ isRequired: boolean; ok: boolean; priority: number }> = [];
    for (const plan of plans) {
      const result = await uploadToTarget(job.id, input.organizationId, plan, backupId, encrypted.body, encrypted.sha256);
      outcomes.push({ isRequired: plan.isRequired, ok: result.ok, priority: plan.priority });
      targetResults.push({
        destinationId: plan.destinationId,
        name: plan.name,
        status: result.ok ? "verified" : "failed",
        error: result.error,
      });
    }

    const status = decideJobStatus(
      policy?.target_mode ?? "all_required",
      outcomes,
      policy?.required_success_count ?? null,
    );

    await prisma.backup_jobs.update({
      where: { id: job.id },
      data: { status, finished_at: new Date() },
    });

    await writeAudit({
      organizationId: input.organizationId,
      actorType: "admin",
      actorId: input.userId,
      action: "backup.run",
      resourceType: "backup_job",
      resourceId: job.id,
      after: { backup_id: backupId, status, size_bytes: staging.sizeBytes, targets: plans.length },
    });

    // 告警放在编排层而不是各个调用点：手动「立即备份」、定时调度、单目标重传
    // 三条入口都会经过这里，漏掉任何一条就等于「这条路径的失败没人知道」。
    // 之前只有 scheduler 里调了 notifyBackupIssue，从后台点「立即备份」失败时
    // 只弹一个 422，审计里一行记录都没有。
    if (status === "failed" || status === "partial" || status === "degraded") {
      const failedTargets = targetResults.filter((item) => item.status === "failed");
      await notifyBackupIssue({
        organizationId: input.organizationId,
        status,
        backupId,
        jobId: job.id,
        policyName: policy?.name ?? null,
        errorCode: status === "failed" ? "BACKUP_FAILED" : "BACKUP_PARTIAL",
        errorMessage:
          failedTargets.length > 0
            ? failedTargets.map((item) => `${item.name}: ${item.error ?? "未知错误"}`).join("; ")
            : null,
        failedTargets: failedTargets.map((item) => item.name),
      });
    }

    return { jobId: job.id, backupId, status, sizeBytes: staging.sizeBytes, manifestSha256: encrypted.sha256, targets: targetResults };
  } catch (error) {
    const message = (error as Error).message;
    // 备份失败必须留下完整堆栈：数据库里只存一句话，排障要看的是哪一行抛的。
    console.error("[backup] runBackup 失败", { backupId, error });
    await prisma.backup_jobs.update({
      where: { id: job.id },
      data: { status: "failed", finished_at: new Date(), error_code: "BACKUP_FAILED", error_message: message.slice(0, 400) },
    });
    // 抛错这条路径最需要告警：pg_dump 挂了、磁盘满了、加密失败都在这里，
    // 而调用方只拿到一句 message，没有任何人会被通知到。
    await notifyBackupIssue({
      organizationId: input.organizationId,
      status: "failed",
      backupId,
      jobId: job.id,
      policyName: policy?.name ?? null,
      errorCode: "BACKUP_FAILED",
      errorMessage: message.slice(0, 400),
    });
    throw error;
  }
}

/** 完整性校验：只读本地暂存文件，重算 SHA-256 并与作业记录比对。 */
export async function verifyJobIntegrity(jobId: string, organizationId: string) {
  const job = await prisma.backup_jobs.findFirst({ where: { id: jobId, organization_id: organizationId } });
  if (!job) throw new Error("备份作业不存在");
  if (!job.local_path || !job.manifest_sha256) throw new Error("该作业没有本地暂存文件，无法做完整性校验");

  const body = await readStagingFile(job.local_path);
  const actual = sha256Hex(body);
  const ok = actual === job.manifest_sha256;
  return {
    ok,
    expected: job.manifest_sha256,
    actual,
    sizeBytes: body.byteLength,
    checkedAt: new Date().toISOString(),
  };
}

/** 隔离恢复演练：恢复进临时库、对账、删库。 */
export async function runRestoreTest(jobId: string, organizationId: string, userId: string | null) {
  const job = await prisma.backup_jobs.findFirst({ where: { id: jobId, organization_id: organizationId } });
  if (!job?.local_path) throw new Error("该作业没有本地暂存文件，无法恢复");

  const record = await prisma.backup_restore_tests.create({
    data: {
      organization_id: organizationId,
      job_id: job.id,
      status: "running",
      test_environment: "isolated-container-db",
      started_at: new Date(),
      created_by: userId,
    },
  });

  const startedAt = Date.now();
  try {
    const encrypted = await readStagingFile(job.local_path);
    const { decryptBackup } = await import("./crypto");
    const dump = decryptBackup(encrypted);

    const [tableRows, licenseRows] = await Promise.all([
      prisma.$queryRaw<Array<{ count: bigint }>>`select count(*)::bigint as count from information_schema.tables where table_schema = 'public'`,
      prisma.licenses.count(),
    ]);

    const outcome = await restoreIntoScratch(dump, {
      tables: Number(tableRows[0]?.count ?? 0),
      licenses: licenseRows,
    });

    await prisma.backup_restore_tests.update({
      where: { id: record.id },
      data: {
        status: outcome.ok ? "passed" : "failed",
        verified_checks_json: outcome.checks as unknown as object[],
        rto_seconds: outcome.rtoSeconds,
        rpo_seconds: job.finished_at ? Math.round((Date.now() - new Date(job.finished_at).getTime()) / 1000) : null,
        finished_at: new Date(),
        error_message: outcome.ok ? null : outcome.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`).join("; ").slice(0, 400),
      },
    });

    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: userId,
      action: "backup.restore_test",
      resourceType: "backup_job",
      resourceId: job.id,
      after: { backup_id: job.backup_id, status: outcome.ok ? "passed" : "failed", rto_seconds: outcome.rtoSeconds },
    });

    return { id: record.id, ...outcome, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    await prisma.backup_restore_tests.update({
      where: { id: record.id },
      data: { status: "failed", finished_at: new Date(), error_message: (error as Error).message.slice(0, 400) },
    });
    throw error;
  }
}

/**
 * 重传单个失败目标（规格 16.11.3：「重试幂等，同名先校验内容不得静默覆盖」）。
 *
 * 顺序刻意是「先读后端再决定写不写」：
 * 上一次上传可能已经成功、只是校验环节超时失败，这时直接标 verified，避免无谓的重复上传。
 * 只有当远端内容确实不一致时才覆盖，并在审计里记下这次覆盖。
 */
export async function retryJobTarget(
  jobId: string,
  organizationId: string,
  targetId: string,
  userId: string | null,
): Promise<{ targetId: string; status: string; reuploaded: boolean; error: string | null }> {
  const job = await prisma.backup_jobs.findFirst({ where: { id: jobId, organization_id: organizationId } });
  if (!job) throw new Error("备份作业不存在");
  if (!job.local_path || !job.manifest_sha256) throw new Error("该作业没有本地暂存文件，无法重传");

  const target = await prisma.backup_job_targets.findFirst({
    where: { id: targetId, job_id: job.id, organization_id: organizationId },
    include: { backup_storage_destinations: true },
  });
  if (!target) throw new Error("备份目标记录不存在");
  if (target.status === "verified") throw new Error("该目标已校验通过，无需重传");

  const body = await readStagingFile(job.local_path);
  const sha256 = sha256Hex(body);
  if (sha256 !== job.manifest_sha256) {
    throw new Error("本地暂存文件已被改动（SHA-256 不匹配），请重新发起一次备份");
  }

  const row = target.backup_storage_destinations as unknown as AdapterRow;
  const remotePath = backupObjectKey(row.remote_prefix, job.backup_id);
  const adapter = await createAdapter(row, organizationId);

  await prisma.backup_job_targets.update({
    where: { id: target.id },
    data: { status: "uploading", error_code: null, error_message: null, retry_count: { increment: 1 } },
  });

  let reuploaded = false;
  try {
    let alreadyMatches = false;
    try {
      const existing = await adapter.get(remotePath);
      alreadyMatches = sha256Hex(existing.body) === sha256;
    } catch {
      // 远端读不到就当作需要重传；不把「读失败」当成「内容不一致」。
      alreadyMatches = false;
    }

    let sizeBytes = target.remote_size_bytes ? Number(target.remote_size_bytes) : body.byteLength;
    if (!alreadyMatches) {
      const put = await adapter.put(remotePath, body);
      sizeBytes = put.sizeBytes;
      reuploaded = true;
    }

    await prisma.backup_job_targets.update({
      where: { id: target.id },
      data: { status: "verifying", remote_size_bytes: BigInt(sizeBytes), checksum_sha256: sha256, uploaded_at: new Date() },
    });

    const fetched = await adapter.get(remotePath);
    const verified = sha256Hex(fetched.body) === sha256;
    await prisma.backup_job_targets.update({
      where: { id: target.id },
      data: {
        status: verified ? "verified" : "failed",
        verified_at: verified ? new Date() : null,
        error_code: verified ? null : "CHECKSUM_MISMATCH",
        error_message: verified ? null : "重传后校验仍不一致",
      },
    });

    await refreshJobStatus(job.id, organizationId);
    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: userId,
      action: "backup.target_retry",
      resourceType: "backup_job_target",
      resourceId: target.id,
      after: { backup_id: job.backup_id, destination_id: target.destination_id, reuploaded, verified },
    });

    return { targetId: target.id, status: verified ? "verified" : "failed", reuploaded, error: verified ? null : "校验不一致" };
  } catch (error) {
    const message = (error as Error).message;
    await prisma.backup_job_targets.update({
      where: { id: target.id },
      data: { status: "failed", error_code: "RETRY_FAILED", error_message: message.slice(0, 400) },
    });
    await refreshJobStatus(job.id, organizationId);
    return { targetId: target.id, status: "failed", reuploaded, error: message };
  }
}

/** 目标状态变化后重算作业总状态（策略取自所属策略，没有策略时按 all_required）。 */
async function refreshJobStatus(jobId: string, organizationId: string): Promise<void> {
  const job = await prisma.backup_jobs.findFirst({
    where: { id: jobId, organization_id: organizationId },
    include: { backup_job_targets: true, backup_policies: true },
  });
  if (!job) return;
  if (job.backup_job_targets.length === 0) return;

  const outcomes = job.backup_job_targets.map((item) => ({
    isRequired: true,
    ok: item.status === "verified",
    priority: 100,
  }));
  const status = decideJobStatus(
    (job.backup_policies?.target_mode ?? "all_required") as "all_required" | "primary_then_fallback" | "quorum",
    outcomes,
    job.backup_policies?.required_success_count ?? null,
  );
  await prisma.backup_jobs.update({ where: { id: job.id }, data: { status } });
}
