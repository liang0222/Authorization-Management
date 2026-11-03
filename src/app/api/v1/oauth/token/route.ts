import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, okResponse, requestMeta, toErrorResponse } from "@/lib/http/api";
import { recordVerification } from "@/lib/domain/audit";
import { authenticateServerAssertion, SERVER_ASSERTION_TYPE } from "@/lib/services/server-auth";
import { enforceRateLimit, ruleForRoute } from "@/lib/services/rate-limit-store";
import { issueServerToken } from "@/lib/services/server-token";
import { loadActiveSigningKey } from "@/lib/domain/signing-key";
import { writeAudit } from "@/lib/domain/audit";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

/**
 * POST /api/v1/oauth/token（规格 4.1.1 / 4.2）：用私钥断言换短期服务端访问令牌。
 *
 * 支持两种入参风格，覆盖现有服务端 SDK 的写法：
 * 1. `application/json`：`{grant_type, client_assertion, client_assertion_type, scope?}`
 * 2. `Authorization: Bearer <assertion>`：断言直接放头里，body 只需 `{}` 或 `grant_type`。
 *
 * 明确拒绝的服务端不该做的事：
 * - `grant_type=client_secret` → 400 `UNSUPPORTED_GRANT_TYPE`。Secret 放在客户端里就等于公开，
 *   本项目只接受 `private_key_jwt`（规格 4.2「公共客户端不允许 Client Credentials」）。
 * - 私有断言里的 `aud` 必须是本服务（由 `authenticateServerAssertion` 校验），
 *   防止别家服务的断言被拿来换我们的令牌。
 */

const schema = z.object({
  grant_type: z.string().trim().max(60).nullish(),
  client_assertion: z.string().trim().max(8192).nullish(),
  client_assertion_type: z.string().trim().max(200).nullish(),
  scope: z.union([z.string().max(500), z.array(z.string().max(80)).max(20)]).nullish(),
  ttl_seconds: z.number().int().positive().max(3600).nullish(),
});

/** 允许申请的 scope 白名单：只能收窄，不能凭空扩张凭证本身没有的权限。 */
function parseScopes(input: z.infer<typeof schema>["scope"]): string[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : input.split(/[\s,]+/);
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))];
}

export async function POST(req: NextRequest) {
  const meta = requestMeta(req);
  const startedAt = performance.now();
  let organizationId: string | null = null;
  let productId: string | null = null;
  let status = 500;
  let errorCode: string | null = null;

  try {
    const cloned = req.clone();
    let body: z.infer<typeof schema> = {};
    const text = await cloned.text();
    if (text.trim().length > 0) {
      try {
        body = schema.parse(JSON.parse(text));
      } catch {
        throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON");
      }
    }

    const grantType = (body.grant_type ?? "private_key_jwt").trim();
    if (grantType !== "private_key_jwt") {
      throw new ApiError(
        400,
        "UNSUPPORTED_GRANT_TYPE",
        "只支持 grant_type=private_key_jwt；本项目不接受 client_secret（公共客户端无法安全保存密钥）",
      );
    }

    // 断言来源：Authorization 头优先，其次 body。
    const header = req.headers.get("authorization");
    const headerAssertion =
      header?.startsWith("Bearer ") && header.slice(7).trim().split(".").length === 3
        ? header.slice(7).trim()
        : null;
    const assertion = headerAssertion ?? body.client_assertion ?? null;
    const assertionType = headerAssertion
      ? SERVER_ASSERTION_TYPE
      : (body.client_assertion_type ?? SERVER_ASSERTION_TYPE);

    if (!assertion) {
      throw new ApiError(401, "CLIENT_AUTH_FAILED", "缺少 client_assertion");
    }

    const identity = await authenticateServerAssertion({ assertion, assertionType });
    organizationId = identity.organizationId;
    productId = identity.productId;

    const limit = await enforceRateLimit({
      rule: ruleForRoute(new URL(req.url).pathname),
      organizationId,
      productId,
      ip: meta.ip,
    });

    const credential = await prisma.product_credentials.findFirst({
      where: {
        id: identity.credentialId,
        organization_id: organizationId,
        // 环境隔离（规格 27.3）：断言本身已按环境校验过，这里再对齐一次，
        // 防止断言签发后凭证被跨环境复制。
        environment: config.credentialEnvironment,
      },
      select: { scopes: true, status: true, client_id: true },
    });
    if (!credential || credential.status !== "active") {
      throw new ApiError(401, "CLIENT_AUTH_FAILED", "凭证已停用");
    }

    // scope 只能收窄：请求了凭证没有的 scope 就直接拒，不要静默降级。
    const available = credential.scopes;
    const requested = parseScopes(body.scope);
    if (requested.length > 0 && available.length > 0) {
      const illegal = requested.filter((item) => !available.includes(item));
      if (illegal.length > 0) {
        throw new ApiError(400, "INVALID_SCOPE", `凭证未被授予这些 scope：${illegal.join("、")}`, {
          available,
        });
      }
    }
    const granted = requested.length > 0 ? requested : available;

    const key = await loadActiveSigningKey(organizationId, productId);
    const keyRow = await prisma.signing_keys.findUnique({
      where: { id: key.id },
      select: { private_key_ref: true },
    });
    if (!keyRow) {
      throw new ApiError(503, "LICENSE_SERVICE_UNAVAILABLE", "签名密钥记录不存在");
    }

    const issued = await issueServerToken({
      identity,
      key,
      privateKeyRef: keyRow.private_key_ref,
      scope: granted,
      ttlSeconds: body.ttl_seconds ?? undefined,
    });

    await writeAudit({
      organizationId,
      actorType: "client",
      actorId: identity.clientId,
      action: "oauth.token.issued",
      resourceType: "server_token",
      resourceId: issued.kid,
      after: { scope: issued.scope, expires_in: issued.expires_in },
      requestId: meta.requestId,
      ip: meta.ip,
    });

    status = 200;
    const response = okResponse(
      {
        access_token: issued.access_token,
        token_type: issued.token_type,
        expires_in: issued.expires_in,
        expires_at: issued.expires_at,
        issued_at: issued.issued_at,
        scope: issued.scope,
        signing_key: { kid: issued.kid, algorithm: "EdDSA" },
      },
      meta.requestId,
    );
    const headers = new Headers(response.headers);
    headers.set("ratelimit-limit", String(limit.limit));
    headers.set("ratelimit-remaining", String(limit.remaining));
    headers.set("ratelimit-reset", String(limit.resetSeconds));
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    const response = toErrorResponse(error, meta.requestId);
    status = response.status;
    if (error instanceof ApiError) errorCode = error.code;
    return response;
  } finally {
    void recordVerification({
      organizationId,
      productId,
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