import { SECURITY_ALERT_THRESHOLDS } from "@/lib/config";

/**
 * 安全告警的纯决策与脱敏逻辑（不碰数据库，便于单元测试）。
 *
 * 服务层（`services/security-alerts.ts`）只负责计数、去重、落审计与投递；
 * 「多少算超阈值」「哪些字段不能进 webhook」放在这里，正反例可以直接测。
 */

export type LoginAlertDimension = "ip" | "email";
export type AuthzAlertDimension = "actor" | "ip";

export interface LoginAlertInput {
  ipFailures: number;
  emailFailures: number;
  distinctIps: number;
  thresholds?: {
    loginFailuresPerIp: number;
    loginFailuresPerEmail: number;
    loginEmailDistinctIps: number;
  };
}

/** 返回本次触发的维度；空数组表示未达阈值。 */
export function evaluateLoginAlert(input: LoginAlertInput): LoginAlertDimension[] {
  const t = input.thresholds ?? SECURITY_ALERT_THRESHOLDS;
  const dimensions: LoginAlertDimension[] = [];
  if (input.ipFailures >= t.loginFailuresPerIp) dimensions.push("ip");
  if (
    input.emailFailures >= t.loginFailuresPerEmail &&
    input.distinctIps >= t.loginEmailDistinctIps
  ) {
    dimensions.push("email");
  }
  return dimensions;
}

export interface AuthzAlertInput {
  actorEvents: number;
  ipEvents: number;
  thresholds?: { authzEventsPerActor: number; authzEventsPerIp: number };
}

/** 403 / 跨租户 404 的越权探测判定。 */
export function evaluateAuthzAlert(input: AuthzAlertInput): AuthzAlertDimension[] {
  const t = input.thresholds ?? SECURITY_ALERT_THRESHOLDS;
  const dimensions: AuthzAlertDimension[] = [];
  if (input.actorEvents >= t.authzEventsPerActor) dimensions.push("actor");
  if (input.ipEvents >= t.authzEventsPerIp) dimensions.push("ip");
  return dimensions;
}

const SENSITIVE_KEY = /password|passwd|secret|token|authorization|cookie|csrf|private[_-]?key|license[_-]?key|access[_-]?key|session/i;

/**
 * 告警 webhook 的最后一道脱敏。
 *
 * 业务代码本就不该把密码/token 放进来，但告警是旁路通道，错误消息可能来自
 * 任意一层（例如备份适配器把带 `?token=` 的 URL 拼进 error_message）。
 * 这里按「键名」丢敏感字段，再按文本模式擦掉 `password=...` / `Bearer ...`
 * 这类常见形态；宁可少一点排障信息，也不让凭据离开进程。
 */
export function redactAlertPayload<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactAlertText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) continue;
      output[key] = redactValue(nested);
    }
    return output;
  }
  return value;
}

export function redactAlertText(text: string): string {
  return text
    .replace(
      /\b(password|passwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*(?!Bearer\b)[^\s,;&]+/gi,
      "$1=[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]");
}
