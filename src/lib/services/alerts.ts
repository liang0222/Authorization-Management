import { config } from "@/lib/config";
import { writeAudit } from "@/lib/domain/audit";
import { redactAlertPayload } from "@/lib/domain/security-alerts";
import { safePostJson } from "@/lib/domain/outbound-http";

/**
 * 通用告警出口（阶段 6）。
 *
 * 备份告警原本把「写审计 + 结构化日志 + 可选 webhook」三段逻辑写在
 * `backup/alerts.ts` 里。登录爆破与越权探测也需要同样的三段式投递，
 * 但它们的审计 action、报文维度、是否等待 webhook 都不同，所以这里只抽
 * **投递机制**，不抽业务语义：
 *
 * 1. 审计日志：有 organizationId 时写 audit_logs（无租户上下文的事件只能
 *    记日志/外发，不能硬塞给某个组织，否则会把平台事件混进客户审计里）。
 * 2. 结构化 stdout：统一 `[<tag>]` 前缀，systemd/journalctl 可 grep。
 * 3. 可选 webhook：读 `ALERT_WEBHOOK_URL`，未设置时回退
 *    `BACKUP_ALERT_WEBHOOK_URL`，兼容阶段 4 已上线的部署。
 *
 * 安全告警的 webhook 是旁路：`awaitWebhook: false` 时只发起请求，业务响应
 * 不等待它，POST 失败也只落日志。备份告警仍保持 await，因为调用方历史上
 * 依赖 `webhook: delivered|failed` 这个结果做排障。
 */

export interface AlertAuditInput {
  organizationId: string | null;
  actorType: "admin" | "system" | "client";
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AlertDeliveryInput {
  /** 审计记录；organizationId 为空时跳过审计。 */
  audit?: AlertAuditInput | null;
  /** journalctl 前缀，例如 `[security][alert]`。 */
  logTag: string;
  logMessage: string;
  /** webhook 请求体，调用方负责保证不含密码/token 等原文。 */
  webhookBody: unknown;
  /** 默认 true；安全告警传 false，避免外部接收端拖慢登录/接口响应。 */
  awaitWebhook?: boolean;
}

export interface AlertDeliveryResult {
  auditWritten: boolean;
  logged: boolean;
  webhook: "skipped" | "delivered" | "failed" | "pending";
}

/** 告警 webhook 地址：新变量优先，旧变量兜底。 */
export function alertWebhookUrl(): string | null {
  return config.alertWebhookUrl;
}

async function postAlertWebhook(url: string, body: string): Promise<"delivered" | "failed"> {
  try {
    const response = await safePostJson({
      url,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "ziming-licensing-alert/1.6",
      },
      timeoutMs: 5_000,
      policy: { allowHttpLoopback: config.deploymentEnv !== "production" },
    });
    if (response.error === null && response.status !== null && response.status >= 200 && response.status < 300) {
      return "delivered";
    }
    console.error(
      `[alert] webhook 投递失败：${response.error ?? `HTTP ${response.status}`}`,
    );
    return "failed";
  } catch (error) {
    // safePostJson 自身不抛，这里防御 URL 解析等意外；告警失败绝不上抛。
    console.error("[alert] webhook 投递异常", error);
    return "failed";
  }
}

export async function emitAlert(input: AlertDeliveryInput): Promise<AlertDeliveryResult> {
  const result: AlertDeliveryResult = { auditWritten: false, logged: false, webhook: "skipped" };

  if (input.audit && input.audit.organizationId) {
    try {
      await writeAudit({
        organizationId: input.audit.organizationId,
        actorType: input.audit.actorType,
        actorId: input.audit.actorId ?? null,
        action: input.audit.action,
        resourceType: input.audit.resourceType,
        resourceId: input.audit.resourceId ?? null,
        after: input.audit.after,
        requestId: input.audit.requestId ?? null,
        ip: input.audit.ip ?? null,
        userAgent: input.audit.userAgent ?? null,
      });
      result.auditWritten = true;
    } catch (error) {
      // writeAudit 内部已兜底，这里再兜一层：审计失败不能影响登录或业务请求。
      console.error("[alert] 写审计失败", error);
    }
  } else if (input.audit) {
    console.warn(`[alert] 事件 ${input.audit.action} 没有组织上下文，跳过审计写入`);
  }

  console.error(`${input.logTag} ${input.logMessage}`);
  result.logged = true;

  const url = alertWebhookUrl();
  if (!url) return result;

  const body = JSON.stringify(redactAlertPayload(input.webhookBody));
  const pending = postAlertWebhook(url, body);
  if (input.awaitWebhook === false) {
    // 安全告警旁路：不 await，失败由 postAlertWebhook 内部记录。
    void pending;
    result.webhook = "pending";
    return result;
  }
  result.webhook = await pending;
  return result;
}
