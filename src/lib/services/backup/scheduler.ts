import { prisma } from "@/lib/db";
import { matchesCron, parseCron } from "@/lib/domain/cron";
import { runBackup } from "@/lib/services/backup/runner";
import { notifyBackupConfigIssue, notifyBackupIssue, checkLocalBackupDisk } from "@/lib/services/backup/alerts";

/**
 * 备份调度器（规格 16.11.3）。
 *
 * 之前 `backup_policies.schedule_cron` 只被校验格式、没有任何进程读取它执行——
 * 策略页写着「到点自动执行」，实际上只有手动点「立即备份」才会跑。这个模块补上真正的定时执行。
 *
 * 设计要点：
 * - **每分钟一个窗口**：每 30 秒 tick 一次，只看「当前这一分钟是否命中 cron」，
 *   命中后先查数据库是否已有同策略同分钟起的作业，避免 tick 重复触发。
 * - **跨实例互斥**：用 PostgreSQL 咨询锁 `pg_try_advisory_lock`，
 *   拿不到锁说明别的实例正在跑同一策略，直接跳过。进程崩溃时锁随连接释放，不会粘住。
 * - **失败告警**：作业结束后按状态发告警（见 alerts.ts），
 *   `failed` 一定告警，`partial`/`degraded` 也告警——「主存储挂了、备存储顶上」必须让人知道。
 * - **磁盘检查**：本地暂存区剩余空间低于阈值时告警，避免备份把自己的磁盘写满。
 */

/** 调度器 tick 间隔。30 秒足够覆盖「每分钟一次」的最细粒度。 */
const TICK_MS = 30_000;
/** 本地备份目录剩余空间低于这个比例就告警。 */
const DISK_ALERT_RATIO = 0.1;
/** 单个策略的执行超时：卡住的作业不能永远占着咨询锁。 */
const RUN_TIMEOUT_MS = 30 * 60_000;

export interface SchedulerTickSummary {
  /** 本轮命中 cron 的策略数。 */
  due: number;
  /** 真正执行的作业数。 */
  ran: number;
  /** 被跳过（并发锁/已有作业）的数量。 */
  skipped: number;
  /** 执行抛错的数量。 */
  failed: number;
}

/** 当前这一分钟的起点（UTC），用于「同策略同分钟去重」。 */
function minuteStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

function advisoryKey(policyId: string): bigint {
  // 取 uuid 前 16 个十六进制字符组成 64 位有符号整数。
  // 用字符串哈希也行，但 uuid 前缀已经足够分散，且可复现、便于排查。
  const hex = policyId.replace(/-/g, "").slice(0, 15);
  return BigInt(`0x${hex}`);
}

/**
 * 执行一条策略：拿咨询锁 → 再确认没有重复作业 → runBackup → 按结果告警 → 释放锁。
 * 返回 "ran" | "skipped"。
 */
async function runPolicy(
  policy: {
    id: string;
    organization_id: string;
    name: string;
    schedule_cron: string;
    timezone: string;
  },
  now: Date,
): Promise<"ran" | "skipped"> {
  const key = advisoryKey(policy.id);

  // 咨询锁是会话级的：用一个专用连接拿锁、跑完、释放。
  const locked = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS locked
  `;
  if (!locked[0]?.locked) return "skipped";

  try {
    // 拿到锁之后再查一次：可能上一个实例刚跑完、作业已经落库。
    const windowStart = minuteStart(now);
    const existing = await prisma.backup_jobs.findFirst({
      where: {
        policy_id: policy.id,
        created_at: { gte: windowStart },
      },
      select: { id: true },
    });
    if (existing) return "skipped";

    const targets = await prisma.backup_policy_targets.findMany({
      where: { policy_id: policy.id },
      select: { destination_id: true, is_required: true },
    });
    if (targets.length === 0) {
      await notifyBackupConfigIssue({
        organizationId: policy.organization_id,
        policyId: policy.id,
        policyName: policy.name,
        reason: "策略没有绑定任何存储目标",
      });
      return "skipped";
    }

    // runBackup 是同步的（pg_dump + 加密 + 上传），单次可能几十秒到几分钟。
    // 用 Promise.race 加超时，避免一次卡死的上传把咨询锁占满整个进程生命周期。
    const run = runBackup({
      organizationId: policy.organization_id,
      userId: null,
      policyId: policy.id,
      trigger: "scheduled",
      onlyDestinationId: null,
    });
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`备份执行超过 ${RUN_TIMEOUT_MS / 60_000} 分钟，已放弃等待`)), RUN_TIMEOUT_MS),
      ),
    ]);

    const failedTargets = result.targets.filter((t) => t.status === "failed").map((t) => t.name);
    const bad = result.status === "failed" || result.status === "partial" || result.status === "degraded";
    if (bad) {
      await notifyBackupIssue({
        organizationId: policy.organization_id,
        status: result.status,
        backupId: result.backupId,
        jobId: result.jobId,
        policyName: policy.name,
        errorCode: result.status === "failed" ? "BACKUP_FAILED" : "BACKUP_PARTIAL",
        errorMessage: failedTargets.length > 0
          ? result.targets.filter((t) => t.status === "failed").map((t) => `${t.name}: ${t.error ?? "未知错误"}`).join("; ")
          : null,
        failedTargets,
      });
    }
    console.log(
      `[backup] policy=${policy.name} backup=${result.backupId} status=${result.status} targets=${result.targets.length}`,
    );
    return "ran";
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`.catch(() => undefined);
  }
}

/** 执行一轮调度检查。导出以便单测与手动触发。 */
export async function tickBackupScheduler(now = new Date()): Promise<SchedulerTickSummary> {
  const summary: SchedulerTickSummary = { due: 0, ran: 0, skipped: 0, failed: 0 };

  const policies = await prisma.backup_policies.findMany({
    where: { enabled: true },
    select: {
      id: true,
      organization_id: true,
      name: true,
      schedule_cron: true,
      timezone: true,
    },
  });

  for (const policy of policies) {
    const fields = parseCron(policy.schedule_cron);
    if (!fields) {
      // 保存时已经校验过，这里只可能是历史脏数据。告警一次，不阻塞其它策略。
      await notifyBackupConfigIssue({
        organizationId: policy.organization_id,
        policyId: policy.id,
        policyName: policy.name,
        reason: `调度表达式无法解析：${policy.schedule_cron}`,
      });
      continue;
    }
    if (!matchesCron(fields, now, policy.timezone)) continue;

    summary.due += 1;
    try {
      const outcome = await runPolicy(policy, now);
      if (outcome === "ran") summary.ran += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await notifyBackupIssue({
        organizationId: policy.organization_id,
        status: "failed",
        backupId: "—",
        jobId: policy.id,
        policyName: policy.name,
        errorCode: "SCHEDULER_ERROR",
        errorMessage: message,
      });
    }
  }

  // 磁盘检查每轮都做：便宜，而且磁盘是「突然写满」的。
  const disk = await checkLocalBackupDisk();
  if (disk && disk.ratio < DISK_ALERT_RATIO) {
    console.error(
      `[backup][alert] 本地备份目录剩余空间不足：${(disk.ratio * 100).toFixed(1)}%（剩余 ${Math.round(disk.freeBytes / 1024 / 1024)}MB）`,
    );
  }

  return summary;
}

/**
 * 启动常驻调度循环。由 `src/instrumentation.ts` 在进程启动时调用一次。
 * `DISABLE_BACKUP_SCHEDULER=true` 可关闭（多实例时只让一个实例调度）。
 */
export function startBackupScheduler(): void {
  const intervalMs = Number(process.env.BACKUP_SCHEDULER_INTERVAL_MS ?? TICK_MS);

  const tick = async () => {
    try {
      const summary = await tickBackupScheduler();
      if (summary.due > 0) {
        console.log(
          `[backup] scheduler due=${summary.due} ran=${summary.ran} skipped=${summary.skipped} failed=${summary.failed}`,
        );
      }
    } catch (error) {
      console.error("[backup] scheduler cycle failed", error);
    }
  };

  setInterval(() => void tick(), intervalMs);
  setTimeout(() => void tick(), 2_000);
  console.log(`[backup] scheduler started, interval=${intervalMs}ms`);
}
