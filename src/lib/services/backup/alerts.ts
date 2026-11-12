import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { writeAudit } from "@/lib/domain/audit";
import { emitAlert } from "@/lib/services/alerts";

/**
 * 备份告警（规格 24 Go-Live Gate：「备份失败、上传失败、磁盘或 API 异常有告警」）。
 *
 * 三条通道，按可靠性递减，任一成功即算送达：
 * 1. **审计日志**：写进 audit_logs（action=backup.job_failed），后台「审计日志」页直接可见，
 *    不需要任何外部依赖，也是事后追责的凭据。
 * 2. **结构化 stdout**：`[backup][alert]` 前缀，systemd 收进 journalctl，
 *    配 `journalctl -u licensing-saas | grep '\[backup\]\[alert\]'` 就能接告警规则。
 * 3. **可选 webhook**：`BACKUP_ALERT_WEBHOOK_URL` 配置后 POST 一条 JSON，
 *    走与 Webhook 投递同一套 SSRF 防护（`safePostJson`）。
 *
 * 为什么不复用业务 Webhook：告警必须在「业务 Webhook 本身出问题」时也能发出，
 * 挂在被监控对象上等于没有监控。所以它是一条独立的、由环境变量配置的通道。
 */

export interface BackupAlertInput {
  organizationId: string;
  /** failed / partial / degraded。 */
  status: string;
  backupId: string;
  jobId: string;
  policyName?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** 失败的目标名，便于一眼看出是哪个存储挂了。 */
  failedTargets?: string[];
}

export interface BackupAlertResult {
  auditWritten: boolean;
  logged: boolean;
  webhook: "skipped" | "delivered" | "failed";
}

function alertText(input: BackupAlertInput): string {
  const targets =
    input.failedTargets && input.failedTargets.length > 0
      ? `；失败目标：${input.failedTargets.join("、")}`
      : "";
  const reason = input.errorCode || input.errorMessage || "未知原因";
  return `备份 ${input.backupId} 状态 ${input.status}（${reason}）${targets}`;
}

export async function notifyBackupIssue(input: BackupAlertInput): Promise<BackupAlertResult> {
  const text = alertText(input);
  // 阶段 6 起投递机制抽到 services/alerts：审计、日志、webhook 的失败语义
  // 与登录/越权告警共用一套。备份仍 await webhook，保持原有
  // `webhook: delivered|failed` 返回值和排障习惯；事件名与报文结构不变。
  const delivered = await emitAlert({
    audit: {
      organizationId: input.organizationId,
      actorType: "system",
      actorId: null,
      action: "backup.job_failed",
      resourceType: "backup_job",
      resourceId: input.jobId,
      after: {
        backup_id: input.backupId,
        status: input.status,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
        policy: input.policyName ?? null,
        failed_targets: input.failedTargets ?? [],
      },
    },
    logTag: "[backup][alert]",
    logMessage: text,
    webhookBody: {
      event: "backup.failed",
      occurred_at: new Date().toISOString(),
      environment: config.deploymentEnv,
      organization_id: input.organizationId,
      backup_id: input.backupId,
      job_id: input.jobId,
      status: input.status,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      policy: input.policyName ?? null,
      failed_targets: input.failedTargets ?? [],
    },
  });
  return {
    auditWritten: delivered.auditWritten,
    logged: delivered.logged,
    webhook: delivered.webhook === "pending" ? "failed" : delivered.webhook,
  };
}

/** 供调度器在「策略根本没有可用目标」这类配置错误上告警。 */
export async function notifyBackupConfigIssue(input: {
  organizationId: string;
  policyId: string;
  policyName: string;
  reason: string;
}): Promise<void> {
  await writeAudit({
    organizationId: input.organizationId,
    actorType: "system",
    actorId: null,
    action: "backup.schedule_skipped",
    resourceType: "backup_policy",
    resourceId: input.policyId,
    after: { policy: input.policyName, reason: input.reason },
  });
  console.error(`[backup][alert] 策略「${input.policyName}」跳过执行：${input.reason}`);
}

/** 磁盘剩余空间检查：低于阈值就告警，避免「备份写满磁盘把数据库拖死」。 */
export async function checkLocalBackupDisk(): Promise<{ freeBytes: number; totalBytes: number; ratio: number } | null> {
  const { statfs } = await import("node:fs/promises");
  try {
    const stats = await statfs(config.backupLocalDir);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return { freeBytes, totalBytes, ratio: totalBytes === 0 ? 0 : freeBytes / totalBytes };
  } catch {
    return null;
  }
}

/** 每个组织最近一次失败作业（供仪表盘与健康检查复用）。 */
export async function recentFailedJobs(organizationId: string, limit = 5) {
  return prisma.backup_jobs.findMany({
    where: { organization_id: organizationId, status: "failed" },
    orderBy: { created_at: "desc" },
    take: limit,
    select: { id: true, backup_id: true, created_at: true, error_code: true, error_message: true },
  });
}
