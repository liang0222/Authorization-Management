import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { ApiError } from "@/lib/http/api";

/**
 * 限额规则本身是纯数据，单独放在 `@/lib/domain/public-rate-limits`：
 * `llms.txt` 生成器与契约测试都要读它，而那些场景不该为了拿一张常量表
 * 就去加载 Prisma 与数据库配置。这里 re-export，保持既有调用点不变。
 */
import { PUBLIC_RATE_LIMITS, ruleForRoute, type RateLimitRule } from "@/lib/domain/public-rate-limits";

export { PUBLIC_RATE_LIMITS, ruleForRoute, type RateLimitRule };

/**
 * 公开 API 的跨实例限流（规格 4.5 / 27.5）。
 *
 * 为什么不是内存计数：Next 的多进程 / 多容器部署下进程内桶各数各的，
 * 攻击者只要让请求落到不同实例就能绕开。这里用 PostgreSQL 的原子 UPSERT
 * 做固定窗口计数，桶按 window 起点对齐，超过窗口后自动重置。
 *
 * 分层：同一个请求同时消耗「产品维度」「IP 维度」「端点维度」三个桶，
 * 任一超限即 429，并返回 RateLimit-Limit / Remaining / Reset 与 Retry-After。
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  scope: string;
}

async function consume(bucketKey: string, limit: number, windowSeconds: number) {
  // 单条 SQL 完成「对齐窗口 + 自增 + 过期重置」，避免读改写竞态。
  const rows = await prisma.$queryRaw<
    Array<{ count: number; window_start: Date; expires_at: Date }>
  >`
    INSERT INTO rate_limit_buckets (bucket_key, window_start, count, expires_at)
    VALUES (
      ${bucketKey},
      to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}::numeric) * ${windowSeconds}::numeric),
      1,
      to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}::numeric) * ${windowSeconds}::numeric)
        + (${windowSeconds} || ' seconds')::interval
    )
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE
        WHEN rate_limit_buckets.window_start = EXCLUDED.window_start
          THEN rate_limit_buckets.count + 1
        ELSE 1
      END,
      window_start = EXCLUDED.window_start,
      expires_at = EXCLUDED.expires_at
    RETURNING count, window_start, expires_at
  `;
  const row = rows[0];
  const resetSeconds = Math.max(
    0,
    Math.ceil((row.expires_at.getTime() - Date.now()) / 1000),
  );
  return {
    allowed: Number(row.count) <= limit,
    count: Number(row.count),
    remaining: Math.max(0, limit - Number(row.count)),
    resetSeconds,
  };
}

/**
 * 逐层检查；返回最严格的一层结果（剩余最少的那个）。
 * `keys` 里空值会被跳过（例如拿不到 IP 时只剩产品与端点两层）。
 */
export async function enforceRateLimit(input: {
  rule: RateLimitRule;
  /** 公开端点（如 /status）没有租户上下文，传 null 表示这一层不计数。 */
  organizationId: string | null;
  productId: string | null;
  ip: string | null;
}): Promise<RateLimitResult> {
  const { rule, organizationId, productId, ip } = input;
  // 键一律带环境前缀：Sandbox 与生产即使误连同一个库，配额也不会互相消耗。
  const prefix = `${config.deploymentEnv}:`;
  const keys: string[] = [];
  if (productId) keys.push(`p:${productId}:${rule.scope}`);
  if (organizationId) keys.push(`e:${organizationId}:${rule.scope}`);
  if (ip) keys.push(`i:${ip}:${rule.scope}`);
  if (keys.length === 0) keys.push(`g:${rule.scope}`);
  const scopedKeys = keys.map((key) => prefix + key);

  let strictest: RateLimitResult = {
    allowed: true,
    limit: rule.limit,
    remaining: rule.limit,
    resetSeconds: rule.windowSeconds,
    scope: rule.scope,
  };

  for (const key of scopedKeys) {
    const result = await consume(key, rule.limit, rule.windowSeconds);
    if (result.remaining < strictest.remaining) {
      strictest = {
        allowed: result.allowed,
        limit: rule.limit,
        remaining: result.remaining,
        resetSeconds: result.resetSeconds,
        scope: rule.scope,
      };
    }
    if (!result.allowed) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        `请求过于频繁，请在 ${result.resetSeconds} 秒后重试`,
        { scope: rule.scope, limit: rule.limit, window_seconds: rule.windowSeconds },
        {
          "retry-after": String(result.resetSeconds),
          "ratelimit-limit": String(rule.limit),
          "ratelimit-remaining": "0",
          "ratelimit-reset": String(result.resetSeconds),
        },
      );
    }
  }

  return strictest;
}

