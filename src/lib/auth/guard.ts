import type { NextRequest } from "next/server";
import {
  ERROR_STATUS,
  ApiError,
  requestMeta,
  toErrorResponse,
  type RequestMeta,
} from "@/lib/http/api";
import {
  SESSION_COOKIE,
  resolveSession,
  verifyCsrf,
  type SessionContext,
} from "@/lib/auth/session";

export interface AdminScope {
  session: SessionContext;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  method: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 管理 API 统一入口：
 * 1) 会话校验；2) CSRF 双提交校验（写操作）；3) RBAC 权限检查；4) 统一错误包装。
 *
 * 隐藏导航不是权限控制本身——每个路由都在这里做服务端校验。
 */
export async function withAdmin(
  req: NextRequest,
  permission: string | null,
  handler: (scope: AdminScope) => Promise<Response>,
): Promise<Response> {
  const meta: RequestMeta = requestMeta(req);
  let session: SessionContext | null = null;
  try {
    session = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    console.error(`[auth] resolve session failed request_id=${meta.requestId}`, error);
    return toErrorResponse(new ApiError(503, "LICENSE_SERVICE_UNAVAILABLE", "会话服务暂时不可用"), meta.requestId);
  }
  if (!session) {
    return toErrorResponse(
      new ApiError(401, "CLIENT_AUTH_FAILED", "登录状态已失效，请重新登录"),
      meta.requestId,
    );
  }
  if (MUTATING.has(meta.method) && !verifyCsrf(req, session)) {
    return toErrorResponse(
      new ApiError(ERROR_STATUS.CSRF_FAILED, "CSRF_FAILED", "CSRF 校验失败，请刷新页面后重试"),
      meta.requestId,
    );
  }
  if (permission && !session.permissions.has(permission)) {
    return toErrorResponse(
      new ApiError(403, "FORBIDDEN", `当前角色缺少权限：${permission}`),
      meta.requestId,
    );
  }
  try {
    return await handler({
      session,
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      method: meta.method,
    });
  } catch (error) {
    return toErrorResponse(error, meta.requestId);
  }
}

export function assertPermission(session: SessionContext, code: string): void {
  if (!session.permissions.has(code)) {
    throw new ApiError(403, "FORBIDDEN", `当前角色缺少权限：${code}`);
  }
}
