import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api";
import { config } from "@/lib/config";

/**
 * 可信服务端身份（规格 4.12 / 27.4）。
 *
 * 浏览器插件、小程序、网站后端都不应该把「能发给客户端的凭证」当成服务端凭证：
 * 公开客户端只要拿到 X-Client-ID 就能自称是它。服务端调用必须用**私钥签名断言**
 * （`private_key_jwt`），服务端只存公钥，私钥不落库、不可下载。
 *
 * 断言是一个紧凑 JWT：
 * - header：`{alg:"EdDSA", kid:"<credential_id>"}`
 * - payload：`{iss, sub, aud, iat, exp, jti}`
 * - `iss` 必须等于 credential.client_id，`aud` 必须等于本服务标识，
 *   `jti` 一次性消费（`server_assertion_jtis` 唯一键兜底重放）。
 */

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CLOCK_SKEW_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

export interface ServerIdentity {
  organizationId: string;
  productId: string;
  credentialId: string;
  clientId: string;
  /** 断言里的 sub：调用方声明的最终用户/租户，仅用于审计，不等于我们的授权主体。 */
  subject: string;
}

interface AssertionClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

/** 校验断言签名并返回声明；不触碰数据库。 */
function verifyAssertionSignature(assertion: string, publicKeyDer: Buffer): AssertionClaims {
  const parts = assertion.split(".");
  if (parts.length !== 3) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 不是合法的紧凑 JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let claims: AssertionClaims;
  try {
    header = decodeSegment(headerB64);
    claims = decodeSegment<AssertionClaims>(payloadB64);
  } catch {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 无法解析");
  }
  if (header.alg !== "EdDSA") {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 必须使用 EdDSA 算法");
  }

  let key;
  try {
    key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  } catch {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "服务端凭证公钥不可用，请轮换凭证");
  }

  const ok = cryptoVerify(
    null,
    Buffer.from(`${headerB64}.${payloadB64}`),
    key,
    Buffer.from(signatureB64, "base64url"),
  );
  if (!ok) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 签名校验失败");
  }
  return claims;
}

function assertClaimsWindow(claims: AssertionClaims, clientId: string): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 缺少 iat/exp");
  }
  if (claims.exp - claims.iat > MAX_TTL_SECONDS) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", `client_assertion 有效期不能超过 ${MAX_TTL_SECONDS} 秒`);
  }
  if (claims.iat > now + CLOCK_SKEW_SECONDS) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 的 iat 在未来");
  }
  if (claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 已过期");
  }
  if (claims.iss !== clientId) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 的 iss 与凭证不匹配");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.assertionAudience)) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 的 aud 不是本服务");
  }
  if (!claims.jti || claims.jti.length < 8) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 必须带 jti");
  }
  if (!claims.sub) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 必须带 sub");
  }
}

/**
 * 解析 `Authorization` 或请求体里的客户端断言。
 * 返回已通过签名、时效与重放检查的服务端身份。
 */
export async function authenticateServerAssertion(input: {
  assertion: string | null;
  assertionType: string | null;
}): Promise<ServerIdentity> {
  if (!input.assertion) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "缺少 client_assertion");
  }
  if (input.assertionType && input.assertionType !== ASSERTION_TYPE) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "不支持的 client_assertion_type");
  }

  // 先读 header 里的 kid 定位凭证，再用该凭证的公钥验签。kid 不可信，必须验签后才采信其余声明。
  const parts = input.assertion.split(".");
  if (parts.length !== 3) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 不是合法的紧凑 JWT");
  }
  let kid: string | undefined;
  try {
    kid = decodeSegment<{ kid?: string }>(parts[0]).kid;
  } catch {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 无法解析");
  }
  if (!kid) throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 缺少 kid");

  const credential = await prisma.product_credentials.findUnique({
    where: { id: kid },
    include: { products: true },
  });
  // 环境隔离（规格 27.3）：跨环境的凭证一律按「无效」处理，不区分「存在但环境不对」，
  // 避免攻击者用错误码差异探测另一个环境里有哪些凭证。
  if (!credential || credential.status !== "active" || credential.environment !== config.credentialEnvironment) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "服务端凭证无效或已停用");
  }
  if (credential.credential_type !== "confidential_server") {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "该凭证不是服务端凭证，不能用于服务端断言");
  }
  if (!credential.public_key) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "服务端凭证未登记公钥");
  }
  if (credential.expires_at && credential.expires_at.getTime() <= Date.now()) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "服务端凭证已过期");
  }
  if (credential.products.status !== "active") {
    throw new ApiError(403, "PRODUCT_DISABLED", "产品已禁用");
  }

  const claims = verifyAssertionSignature(input.assertion, Buffer.from(credential.public_key));
  assertClaimsWindow(claims, credential.client_id);

  // jti 一次性：主键冲突即重放。用 create 捕获 P2002，而不是先查后写（避免竞态）。
  try {
    await prisma.server_assertion_jtis.create({
      data: {
        jti: claims.jti,
        organization_id: credential.organization_id,
        product_id: credential.product_id,
        credential_id: credential.id,
        subject: claims.sub.slice(0, 200),
        expires_at: new Date(claims.exp * 1000),
      },
    });
  } catch {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "client_assertion 的 jti 已被使用（疑似重放）");
  }

  await prisma.product_credentials.update({
    where: { id: credential.id },
    data: { last_used_at: new Date() },
  });

  return {
    organizationId: credential.organization_id,
    productId: credential.product_id,
    credentialId: credential.id,
    clientId: credential.client_id,
    subject: claims.sub,
  };
}

export const SERVER_ASSERTION_TYPE = ASSERTION_TYPE;
