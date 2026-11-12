/**
 * 安装接口的访问保护（规格 §六 安全要求）。
 *
 * 安装期没有任何登录态可用，所以这里用三层：
 *   1. CSRF 双提交 + HMAC 绑定：GET 发一个 `nonce.sig` 的 cookie，
 *      前端每次 POST 都把它原样放进 `x-install-csrf` 头。签名密钥不发给浏览器，
 *      因此攻击者只能复制自己的 token，无法伪造受害者的。
 *   2. 同源校验：POST 必须带 Origin，且 host 与请求 host 一致。
 *   3. 频率限制：按 IP 的滑动窗口，防暴力试参数。
 *
 * 另外：安装状态从不依赖 Cookie（状态在锁文件与数据库里），Cookie 只是防跨站。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { atomicWrite, ensureDir } from "./store";

export const CSRF_COOKIE = "install_csrf";
export const CSRF_HEADER = "x-install-csrf";
const TOKEN_TTL_MS = 60 * 60 * 1000;

/** 取签名密钥：优先环境变量，其次数据目录里的随机文件，最后退化为进程内随机。 */
let processFallbackSecret: Buffer | null = null;

function csrfSecret(dataDir: string): Buffer {
  const fromEnv = process.env.INSTALLER_CSRF_SECRET ?? process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, "utf8");

  try {
    ensureDir(dataDir);
    const path = join(dataDir, "csrf.key");
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (raw.length >= 32) return Buffer.from(raw, "base64url");
    }
    const fresh = randomBytes(32);
    atomicWrite(path, fresh.toString("base64url"));
    return fresh;
  } catch {
    // 数据目录不可写（环境检测会报出来）时退化为进程内密钥：
    // 服务重启会让旧 token 失效，但安全性不降低。
    processFallbackSecret ??= randomBytes(32);
    return processFallbackSecret;
  }
}

function sign(secret: Buffer, nonce: string, issuedAt: number): string {
  return createHmac("sha256", secret).update(`${nonce}.${issuedAt}`).digest("base64url");
}

export interface IssuedToken {
  token: string;
  maxAgeSeconds: number;
}

export function issueCsrfToken(dataDir: string): IssuedToken {
  const secret = csrfSecret(dataDir);
  const nonce = randomBytes(16).toString("base64url");
  const issuedAt = Date.now();
  return {
    token: `${nonce}.${issuedAt}.${sign(secret, nonce, issuedAt)}`,
    maxAgeSeconds: Math.floor(TOKEN_TTL_MS / 1000),
  };
}

export function verifyCsrfToken(dataDir: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedRaw, signature] = parts;
  const issuedAt = Number(issuedRaw);
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > TOKEN_TTL_MS) return false;
  if (Date.now() - issuedAt < -60_000) return false;

  const expected = Buffer.from(sign(csrfSecret(dataDir), nonce, issuedAt), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ 频率限制 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5000;

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const INSTALL_RATE_LIMIT: RateLimitRule = { limit: 40, windowMs: 60_000 };

export function checkRateLimit(key: string, rule: RateLimitRule = INSTALL_RATE_LIMIT): {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < rule.windowMs);

  if (bucket.hits.length >= rule.limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((rule.windowMs - (now - oldest)) / 1000)),
    };
  }

  bucket.hits.push(now);
  // 简单的容量控制，避免被大量伪造 IP 撑爆内存。
  if (buckets.size > MAX_BUCKETS && !buckets.has(key)) {
    const firstKey = buckets.keys().next().value;
    if (firstKey !== undefined) buckets.delete(firstKey);
  }
  buckets.set(key, bucket);
  return { ok: true, remaining: rule.limit - bucket.hits.length, retryAfterSeconds: 0 };
}

/** 仅供测试：清空限流桶。 */
export function resetRateLimits(): void {
  buckets.clear();
}

/* ------------------------------------------------------------------ 请求校验 */

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    "unknown"
  );
}

/** 同源校验：POST 必须带 Origin，且与请求 host 一致。 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const host = req.headers.get("host");
    if (!host) return false;
    if (originHost === host) return true;
    // 反代场景：X-Forwarded-Host 才是外部域名。
    const forwarded = req.headers.get("x-forwarded-host");
    return Boolean(forwarded && originHost === forwarded);
  } catch {
    return false;
  }
}

export interface GuardFailure {
  response: NextResponse;
}

/**
 * POST 前的统一检查。返回 null 表示放行。
 * 注意：这里不检查安装状态——那是各路由自己的职责（且必须检查）。
 */
export function guardInstallPost(req: Request, dataDir: string): GuardFailure | null {
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          code: "RATE_LIMITED",
          message: "请求过于频繁，请稍后重试",
          request_id: `req_${randomBytes(8).toString("hex")}`,
          server_time: new Date().toISOString(),
          data: null,
        },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
      ),
    };
  }

  if (!sameOrigin(req)) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          code: "ORIGIN_REJECTED",
          message: "请求来源校验失败，请从安装向导页面发起操作",
          request_id: `req_${randomBytes(8).toString("hex")}`,
          server_time: new Date().toISOString(),
          data: null,
        },
        { status: 403 },
      ),
    };
  }

  const header = req.headers.get(CSRF_HEADER);
  if (!verifyCsrfToken(dataDir, header)) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          code: "CSRF_REJECTED",
          message: "CSRF 校验失败，请刷新安装页面后重试",
          request_id: `req_${randomBytes(8).toString("hex")}`,
          server_time: new Date().toISOString(),
          data: null,
        },
        { status: 403 },
      ),
    };
  }

  return null;
}

export function envelope<T>(data: T, message = "成功") {
  return {
    ok: true,
    code: "OK",
    message,
    request_id: `req_${randomBytes(8).toString("hex")}`,
    server_time: new Date().toISOString(),
    data,
  };
}

export function failure(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      request_id: `req_${randomBytes(8).toString("hex")}`,
      server_time: new Date().toISOString(),
      data: extra ?? null,
    },
    { status },
  );
}
