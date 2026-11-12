/**
 * 进程内限流器：用于登录/验证接口的第一道防线。
 * 单实例部署足够；多实例生产环境应换成 Redis 计数（规格架构中的 Redis）。
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0, remaining: limit - 1 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfterSeconds: 0, remaining: limit - bucket.count };
}

/**
 * 只读检查：判断当前 key 是否已被打满，但不消耗额度。
 * 用于「成功不计数、只对失败计数」的登录限流。
 */
export function checkRateLimit(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    return { allowed: true, retryAfterSeconds: 0, remaining: limit };
  }
  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfterSeconds: 0, remaining: limit - bucket.count };
}

/** 记录一次失败尝试（递增计数），返回递增后的限流状态。 */
export function recordFailure(key: string, limit: number, windowMs: number): RateLimitResult {
  return rateLimit(key, limit, windowMs);
}

/** 成功后清零该 key 的失败计数。 */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** 定时清理过期桶，避免长时间运行内存增长。 */
if (!(globalThis as { __rateLimitTimer?: NodeJS.Timeout }).__rateLimitTimer) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60_000);
  timer.unref?.();
  (globalThis as { __rateLimitTimer?: NodeJS.Timeout }).__rateLimitTimer = timer;
}
