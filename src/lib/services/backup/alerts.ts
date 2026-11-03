import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { writeAudit } from "@/lib/domain/audit";
import { safePostJson } from "@/lib/domain/outbound-http";

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
  const result: BackupAlertResult = { auditWritten: false, logged: false, webhook: "skipped" };

  // 1. 审计日志
  try {
    await writeAudit({
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
    });
    result.auditWritten = true;
  } catch {
    // writeAudit 内部已兜底，这里只是防御性处理
  }

  // 2. journalctl 结构行
  console.error(`[backup][alert] ${text}`);
  result.logged = true;

  // 3. 可选外部 webhook
  const url = process.env.BACKUP_ALERT_WEBHOOK_URL;
  if (!url) return result;

  const body = JSON.stringify({
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
  });

  const response = await safePostJson({
    url,
    body,
    headers: { "content-type": "application/json", "user-agent": "ziming-licensing-backup-alert/1.5" },
    timeoutMs: 5_000,
    policy: { allowHttpLoopback: config.deploymentEnv !== "production" },
  });
  result.webhook =
    response.error === null && response.status !== null && response.status >= 200 && response.status < 300
      ? "delivered"
      : "failed";
  if (result.webhook === "failed") {
    console.error(`[backup][alert] 告警 webhook 投递失败：${response.error ?? `HTTP ${response.status}`}`);
  }
  return result;
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
