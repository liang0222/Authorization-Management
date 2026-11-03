import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { decodeCursor, encodeCursor } from "@/lib/domain/cursor";

/** 统一成功响应（规格 4.2）。 */
export interface ApiEnvelope<T> {
  ok: true;
  code: "OK";
  message: string;
  request_id: string;
  server_time: string;
  data: T;
}

/** 统一错误响应（规格 4.3）。 */
export interface ApiErrorEnvelope {
  ok: false;
  code: string;
  message: string;
  request_id: string;
  server_time: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** 额外响应头，例如限流的 RateLimit-* 与 Retry-After。 */
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

/**
 * 错误码 → HTTP 状态码。
 *
 * 刻意**不加** `: Record<string, number>` 标注：那会让 `keyof typeof ERROR_STATUS`
 * 退化成 `string`，于是「用 `Record<keyof typeof ERROR_STATUS, T>` 逼编译期补齐」
 * 这类检查全部变成假的（缺键照样通过）。这里保持字面量对象 + `as const`，
 * 真正的错误码联合类型由 `ErrorCode` 给出。
 */
export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  CLIENT_AUTH_FAILED: 401,
  MFA_REQUIRED: 401,
  CSRF_FAILED: 403,
  FORBIDDEN: 403,
  PRODUCT_DISABLED: 403,
  RESOURCE_NOT_FOUND: 404,
  LICENSE_ALREADY_BOUND: 409,
  DEVICE_LIMIT_EXCEEDED: 409,
  ACTIVATION_LIMIT_REACHED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CONFLICT: 409,
  LICENSE_EXPIRED: 410,
  ACTIVATION_WINDOW_EXPIRED: 410,
  LICENSE_SUSPENDED: 423,
  DEVICE_BLOCKED: 423,
  LICENSE_INVALID: 422,
  PRODUCT_MISMATCH: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  LICENSE_SERVICE_UNAVAILABLE: 503,
} as const;

/** 服务端会返回的错误码联合类型。新增错误码请改上面的对象，类型自动跟着变。 */
export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * 按错误码构造 ApiError：HTTP 状态码由 `ERROR_STATUS` 唯一决定。
 *
 * 为什么需要这个函数：这些位置原先写的是两档三元表达式，例如
 * `state.activationBlockReason === "LICENSE_SUSPENDED" ? 423 : 410`、
 * `state.activationBlockReason === "DEVICE_LIMIT_EXCEEDED" ? 409 : 423`。
 * 它们只区分「某一种」原因，其余原因全落到另一个状态码上，结果就是
 * **同一个 error_code 在不同端点返回不同 HTTP 状态码**（真实数据里
 * `LICENSE_EXPIRED` 出现过 409/410/422，`DEVICE_LIMIT_EXCEEDED` 出现过 409/410/422/423）。
 * 客户端按 code 分支会拿到互相矛盾的语义，按 status 分支又会归错错误族。
 *
 * 把 code 作为唯一输入，status 就只有一处定义；新增原因时不用再改调用点。
 */
export function apiError(
  code: ErrorCode,
  message: string,
  details?: unknown,
  headers?: Record<string, string>,
): ApiError {
  return new ApiError(ERROR_STATUS[code], code, message, details, headers);
}

export interface RequestMeta {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  method: string;
}

export function requestMeta(req: NextRequest): RequestMeta {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  return {
    requestId: req.headers.get("x-request-id") || `req_${randomUUID().replace(/-/g, "")}`,
    ip,
    userAgent: req.headers.get("user-agent"),
    method: req.method,
  };
}

export function successBody<T>(data: T, requestId: string): ApiEnvelope<T> {
  return {
    ok: true,
    code: "OK",
    message: "success",
    request_id: requestId,
    server_time: new Date().toISOString(),
    data,
  };
}

export function okResponse<T>(data: T, requestId: string, init?: { status?: number; headers?: HeadersInit }) {
  const body = successBody(data, requestId);
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", requestId);
  headers.set("cache-control", "no-store");
  return Response.json(body, { status: init?.status ?? 200, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const body: ApiErrorEnvelope = {
    ok: false,
    code,
    message,
    request_id: requestId,
    server_time: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  };
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store", ...extraHeaders },
  });
}

/** 把任意异常转换成统一错误响应；Zod 校验错误定位到具体字段。 */
export function toErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return errorResponse(
      error.status,
      error.code,
      error.message,
      requestId,
      error.details,
      error.headers,
    );
  }
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const path = issue.path.join(".") || "_";
      if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return errorResponse(400, "INVALID_REQUEST", "请求参数校验失败", requestId, { fieldErrors });
  }
  console.error(`[api] unhandled error request_id=${requestId}`, error);
  return errorResponse(500, "INTERNAL_ERROR", "服务端内部错误", requestId);
}

/** 解析并校验 JSON 请求体。 */
export async function readJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON");
  }
  return schema.parse(raw);
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  /** 下一页游标；null 表示没有更多。字段为新增，旧客户端可忽略。 */
  next_cursor: string | null;
  has_more: boolean;
  /** 与 next_cursor/has_more 同源的嵌套形式，便于按规格 27.5 直接取用。 */
  pagination: { next_cursor: string | null; has_more: boolean; limit: number };
}

export interface PageResult<T> extends PageMeta {
  items: T[];
}

export interface ListQuery {
  page: number;
  pageSize: number;
  skip: number;
  q: string;
  sort: string | null;
  order: "asc" | "desc";
  raw: URLSearchParams;
  /** 本次请求是否由游标驱动（true 时 page 只是换算出来的展示值）。 */
  fromCursor: boolean;
  /** 解析前的原始游标，非法游标在 readListQuery 里已抛 400。 */
  cursor: string | null;
  /** 游标作用域，默认取请求路径，用于阻止游标跨接口复用。 */
  scope: string;
}

/** 服务端分页参数（限制 pageSize 上限，避免一次拉全表）。 */
/**
 * 列表查询参数（规格 27.5 要求游标分页）。
 *
 * 两种入口共存：
 * - 游标：`?cursor=<opaque>&limit=20`，游标里签名了位置，客户端改不动；
 * - 旧偏移：`?page=3&pageSize=20`，保留给现有后台页面与旧脚本。
 *
 * `scope` 是接口路径，用来绑定游标作用域；不传 scope 时忽略 cursor 参数（防止
 * 一个未绑定作用域的接口收下游标却无法验签，反而让人误以为分页生效）。
 */
export function readListQuery(url: URL, defaultPageSize = 20, scopeOverride?: string): ListQuery {
  const raw = url.searchParams;
  const scope = scopeOverride ?? url.pathname;
  const cursorParam = (raw.get("cursor") ?? "").trim();
  const limitParam = Number(raw.get("limit") ?? NaN);
  const requested = Number(raw.get("pageSize") ?? (Number.isFinite(limitParam) ? limitParam : NaN));
  const pageSize = Math.min(100, Math.max(1, requested || defaultPageSize));

  if (cursorParam) {
    const decoded = decodeCursor(cursorParam, scope);
    if (!decoded) {
      throw new ApiError(400, "INVALID_REQUEST", "游标无效或已过期，请从第一页重新请求");
    }
    return {
      page: Math.floor(decoded.offset / pageSize) + 1,
      pageSize,
      skip: decoded.offset,
      q: (raw.get("q") ?? "").trim(),
      sort: raw.get("sort"),
      order: raw.get("order") === "asc" ? "asc" : "desc",
      raw,
      fromCursor: true,
      cursor: cursorParam,
      scope,
    };
  }

  const page = Math.max(1, Number(raw.get("page") ?? 1) || 1);
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    q: (raw.get("q") ?? "").trim(),
    sort: raw.get("sort"),
    order: raw.get("order") === "asc" ? "asc" : "desc",
    raw,
    fromCursor: false,
    cursor: null,
    scope,
  };
}

export interface CursorFields {
  next_cursor: string | null;
  has_more: boolean;
  /** 与 next_cursor/has_more 同源的嵌套形式，便于按规格 27.5 直接取 data.page.*。 */
  pagination: { next_cursor: string | null; has_more: boolean; limit: number };
}

/**
 * 游标字段（供手写 `{items, page, pageSize, total, pageCount}` 的端点复用）。
 *
 * 这些端点历史上是手拼响应对象而不是走 `pageResult`，直接改成 pageResult 会打乱
 * 它们各自的额外字段（counts、summary 等）。所以只把游标三件套拆出来 spread 进去，
 * 保持旧字段原样 —— 旧客户端继续用 page/pageCount，新客户端用 next_cursor/has_more。
 */
export function cursorFields(
  itemCount: number,
  total: number,
  query: ListQuery,
  scopeOverride?: string,
): CursorFields {
  const scope = scopeOverride ?? query.scope;
  const consumed = query.skip + itemCount;
  const hasMore = itemCount > 0 && consumed < total;
  const nextCursor = hasMore ? encodeCursor({ offset: consumed, scope }) : null;
  return {
    next_cursor: nextCursor,
    has_more: hasMore,
    pagination: { next_cursor: nextCursor, has_more: hasMore, limit: query.pageSize },
  };
}

export function pageResult<T>(
  items: T[],
  total: number,
  query: ListQuery,
  scopeOverride?: string,
): PageResult<T> {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
    ...cursorFields(items.length, total, query, scopeOverride),
  };
}

/** 白名单式排序：避免把用户输入直接拼进 orderBy。 */
export function parseSort<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value && (allowed as readonly string[]).includes(value)) return value as T;
  return fallback;
}

export function asString(value: string | null): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function asEnum<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
