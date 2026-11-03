import type { NextRequest } from "next/server";
import { ApiError, requestMeta, toErrorResponse } from "@/lib/http/api";
import { recordVerification } from "@/lib/domain/audit";
import { authenticateServerAssertion, SERVER_ASSERTION_TYPE, type ServerIdentity } from "@/lib/services/server-auth";
import { enforceRateLimit, ruleForRoute } from "@/lib/services/rate-limit-store";

/**
 * 服务端可信调用的统一入口（规格 4.12 / 27.4）。
 *
 * 与 `withPublic` 的差别：
 * - 认证是私钥签名断言（private_key_jwt），不是 X-Client-ID。
 * - 断言可以放在请求体（`client_assertion`）或 `Authorization: Bearer`（JWT）里，
 *   两种写法都在 OAuth 生态里常见，SDK 可以任选。
 * - 同样写验证日志、同样分层限流。
 */
export interface ServerScope {
  identity: ServerIdentity;
  requestId: string;
  ip: string | null;
  method: string;
}

export async function withServerAssertion(
  req: NextRequest,
  handler: (scope: ServerScope) => Promise<Response>,
): Promise<Response> {
  const meta = requestMeta(req);
  const startedAt = performance.now();
  let identity: ServerIdentity | null = null;
  let status = 500;
  let errorCode: string | null = null;
  try {
    const { assertion, assertionType } = await readAssertion(req);
    identity = await authenticateServerAssertion({ assertion, assertionType });

    const rule = ruleForRoute(new URL(req.url).pathname);
    const limit = await enforceRateLimit({
      rule,
      organizationId: identity.organizationId,
      productId: identity.productId,
      ip: meta.ip,
    });

    const response = await handler({
      identity,
      requestId: meta.requestId,
      ip: meta.ip,
      method: meta.method,
    });
    status = response.status;
    const headers = new Headers(response.headers);
    headers.set("ratelimit-limit", String(limit.limit));
    headers.set("ratelimit-remaining", String(limit.remaining));
    headers.set("ratelimit-reset", String(limit.resetSeconds));
    return new Response(response.body, { status, headers });
  } catch (error) {
    const response = toErrorResponse(error, meta.requestId);
    status = response.status;
    if (error instanceof ApiError) errorCode = error.code;
    return response;
  } finally {
    void recordVerification({
      organizationId: identity?.organizationId ?? null,
      productId: identity?.productId ?? null,
      requestId: meta.requestId,
      method: meta.method,
      route: new URL(req.url).pathname,
      status,
      errorCode,
      latencyMs: Math.round(performance.now() - startedAt),
      ip: meta.ip,
    });
  }
}

/**
 * 从 Authorization: Bearer 或请求体读取断言。
 * 请求体只能读一次，这里用 clone() 读副本，业务 handler 仍能正常 `req.json()`。
 */
async function readAssertion(
  req: NextRequest,
): Promise<{ assertion: string | null; assertionType: string | null }> {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token.split(".").length === 3) {
      return { assertion: token, assertionType: SERVER_ASSERTION_TYPE };
    }
  }
  const cloned = req.clone();
  let body: { client_assertion?: unknown; client_assertion_type?: unknown } = {};
  try {
    body = (await cloned.json()) as typeof body;
  } catch {
    body = {};
  }
  const assertion = typeof body.client_assertion === "string" ? body.client_assertion : null;
  const assertionType =
    typeof body.client_assertion_type === "string" ? body.client_assertion_type : null;
  return { assertion, assertionType };
}
