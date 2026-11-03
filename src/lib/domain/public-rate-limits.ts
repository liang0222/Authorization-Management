/**
 * 公开 API 的限额规则（规格 27.5）。
 *
 * 单独成模块而不是留在 `rate-limit-store.ts` 里，是因为这张表有两类读者：
 * 一类是真正要计数、需要数据库的实现；另一类是「只想读数值」的消费者 ——
 * `llms.txt` 生成器、契约测试、公开文档页。后者不该为了几个常量就拖起 Prisma。
 *
 * 数值口径：单产品单 IP / 60 秒固定窗口。
 */

export interface RateLimitRule {
  /** 端点族名，用于拼 bucket_key 与在日志里区分。 */
  scope: string;
  /** 窗口内允许的请求数。 */
  limit: number;
  /** 窗口长度（秒）。 */
  windowSeconds: number;
}

/** 端点族 → 限额。数值是「单产品单 IP」口径，公开文档 27.5 需要能对上。 */
export const PUBLIC_RATE_LIMITS: Record<string, RateLimitRule> = {
  "activation-challenges": { scope: "challenge", limit: 30, windowSeconds: 60 },
  activations: { scope: "activate", limit: 10, windowSeconds: 60 },
  "activations/heartbeat": { scope: "heartbeat", limit: 60, windowSeconds: 60 },
  "activations/deactivate": { scope: "deactivate", limit: 10, windowSeconds: 60 },
  "activations/entitlements": { scope: "entitlements", limit: 120, windowSeconds: 60 },
  "licenses/validate": { scope: "validate", limit: 30, windowSeconds: 60 },
  "server/licenses/check": { scope: "server_check", limit: 120, windowSeconds: 60 },
  "offline-grants": { scope: "offline_grant", limit: 10, windowSeconds: 60 },
  // 换令牌比业务调用便宜，但仍然限流：断言验签是 CPU 密集操作（Ed25519）。
  "oauth/token": { scope: "oauth_token", limit: 60, windowSeconds: 60 },
  default: { scope: "public", limit: 120, windowSeconds: 60 },
};

export function ruleForRoute(pathname: string): RateLimitRule {
  const suffix = pathname.replace(/^\/api\/v1\//, "");
  // /activations/{activation_id}/entitlements 要归一化，否则每个 activation 都是新桶。
  const normalized = suffix.replace(/^activations\/[0-9a-f-]{36}\/entitlements$/, "activations/entitlements");
  return PUBLIC_RATE_LIMITS[normalized] ?? PUBLIC_RATE_LIMITS.default;
}
