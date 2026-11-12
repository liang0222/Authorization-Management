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
import { observeAuthzFailure } from "@/lib/services/security-alerts";

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
  const current = session;
  /**
   * 越权探测计数：403（权限不足 / CSRF）与跨租户 404 都算。
   *
   * 只旁路观察：`observeAuthzFailure` 内部吞掉所有异常，且这里不 await，
   * 不让审计/告警拖慢原本应该在毫秒级返回的拒绝响应。
   */
  const observeAuthz = (status: number) => {
    void observeAuthzFailure({
      organizationId: current.organization.id,
      userId: current.user.id,
      userEmail: current.user.email,
      ip: meta.ip,
      status,
      method: meta.method,
      path: new URL(req.url).pathname,
      requestId: meta.requestId,
      userAgent: meta.userAgent,
    });
  };
  if (MUTATING.has(meta.method) && !verifyCsrf(req, current)) {
    observeAuthz(ERROR_STATUS.CSRF_FAILED);
    return toErrorResponse(
      new ApiError(ERROR_STATUS.CSRF_FAILED, "CSRF_FAILED", "CSRF 校验失败，请刷新页面后重试"),
      meta.requestId,
    );
  }
  if (permission && !current.permissions.has(permission)) {
    observeAuthz(403);
    return toErrorResponse(
      new ApiError(403, "FORBIDDEN", `当前角色缺少权限：${permission}`),
      meta.requestId,
    );
  }
  try {
    return await handler({
      session: current,
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      method: meta.method,
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 403 || status === 404) observeAuthz(status);
    return toErrorResponse(error, meta.requestId);
  }
}

export function assertPermission(session: SessionContext, code: string): void {
  if (!session.permissions.has(code)) {
    throw new ApiError(403, "FORBIDDEN", `当前角色缺少权限：${code}`);
  }
}
