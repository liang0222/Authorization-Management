import type { NextRequest } from "next/server";
import { ApiError, requestMeta, toErrorResponse } from "@/lib/http/api";
import { recordVerification } from "@/lib/domain/audit";
import { resolvePublicClient, type PublicClient } from "@/lib/services/activations";
import { sha256, bytesEqual, toPrismaBytes } from "@/lib/auth/totp";
import { prisma } from "@/lib/db";
import { enforceRateLimit, ruleForRoute } from "@/lib/services/rate-limit-store";

/**
 * 公开客户端 API 的统一入口：
 * 认证（X-Client-ID）→ 业务处理 → 写入验证日志（api_request_logs）。
 * 公开接口不返回内部堆栈，错误统一走 4.3 的错误响应包。
 */
export interface PublicScope {
  client: PublicClient;
  requestId: string;
  ip: string | null;
  method: string;
  requestIdHeader: string;
}

export async function withPublic(
  req: NextRequest,
  handler: (scope: PublicScope) => Promise<Response>,
): Promise<Response> {
  const meta = requestMeta(req);
  const startedAt = performance.now();
  let client: PublicClient | null = null;
  let status = 500;
  let errorCode: string | null = null;
  try {
    client = await resolvePublicClient(req.headers.get("x-client-id"));

    // 分层限流：产品维度 + IP 维度 + 端点维度，任一超限即 429（带 Retry-After）。
    // 放在鉴权之后，避免未认证流量把桶打满而影响正常客户端。
    const rule = ruleForRoute(new URL(req.url).pathname);
    const limit = await enforceRateLimit({
      rule,
      organizationId: client.organizationId,
      productId: client.productId,
      ip: meta.ip,
    });

    const response = await handler({
      client,
      requestId: meta.requestId,
      ip: meta.ip,
      method: meta.method,
      requestIdHeader: meta.requestId,
    });
    status = response.status;
    // 成功响应也带上限流快照，客户端可以据此自适应。
    const headers = new Headers(response.headers);
    headers.set("ratelimit-limit", String(limit.limit));
    headers.set("ratelimit-remaining", String(limit.remaining));
    headers.set("ratelimit-reset", String(limit.resetSeconds));
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    const response = toErrorResponse(error, meta.requestId);
    status = response.status;
    if (error instanceof ApiError) errorCode = error.code;
    return response;
  } finally {
    void recordVerification({
      organizationId: client?.organizationId ?? null,
      productId: client?.productId ?? null,
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
 * 幂等写操作（规格 4.1 / 4.7）：同 key + 同请求体返回首次响应；同 key 不同请求体返回 409。
 */
export async function withIdempotency(
  req: NextRequest,
  client: PublicClient,
  scope: string,
  rawBody: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key || key.length < 8) {
    throw new ApiError(400, "INVALID_REQUEST", "写操作必须提供 Idempotency-Key（≥8 字符）");
  }
  const requestHash = sha256(rawBody);
  const existing = await prisma.idempotency_records.findUnique({
    where: {
      product_id_scope_idempotency_key: {
        product_id: client.productId,
        scope,
        idempotency_key: key,
      },
    },
  });
  if (existing) {
    if (!bytesEqual(existing.request_hash, requestHash)) {
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "相同幂等键但请求体不同");
    }
    if (existing.response_body && existing.response_status) {
      return Response.json(existing.response_body, {
        status: existing.response_status,
        headers: {
          "x-request-id": (existing.response_body as { request_id?: string }).request_id ?? "replayed",
          "x-idempotent-replay": "true",
          "cache-control": "no-store",
        },
      });
    }
  }

  const response = await handler();
  if (response.ok) {
    const body = await response.clone().json();
    await prisma.idempotency_records.create({
      data: {
        organization_id: client.organizationId,
        product_id: client.productId,
        scope,
        idempotency_key: key,
        request_hash: toPrismaBytes(requestHash),
        response_status: response.status,
        response_body: body as never,
        expires_at: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
  }
  return response;
}

export function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}
