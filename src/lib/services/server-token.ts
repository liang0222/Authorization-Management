import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import {
  canonicalJson,
  loadPrivateKey,
  signBytes,
  type ActiveSigningKey,
} from "@/lib/domain/signing-key";
import type { ServerIdentity } from "@/lib/services/server-auth";

/**
 * 服务端访问令牌（规格 4.1.1 / 4.2）。
 *
 * 为什么需要它：`private_key_jwt` 每次调用都要生成断言 + 一次 jti 消费（写库），
 * 高频服务端调用（比如每秒几十次的许可证校验）成本太高。OAuth 的常规做法是
 * **先用私钥断言换一个短期 access token，再用它调业务接口**。本模块就是那个令牌。
 *
 * 与激活访问令牌的区别：
 * - 激活令牌是 HMAC（对称、两段式），只能证明「某台已激活设备」；
 * - 服务端令牌是 **Ed25519 非对称签名（三段 JWT）**，带 `token_use: "server_access"`，
 *   客户端可以离线验签；`kid` 指回 `signing_keys`，支持公钥轮换。
 *
 * 安全约束：
 * - 默认 15 分钟，最长 60 分钟（`MAX_TTL_SECONDS`），刷新靠再换一次而不是续期；
 * - 令牌只含「是哪把凭证、哪个产品、哪些 scope」，不含任何客户数据；
 * - 验签失败一律 401，不区分「签名错」与「令牌伪造」，避免探测。
 */

const ISSUER = "ziming-license";
const MAX_TTL_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 900;
const TOKEN_USE = "server_access";

export interface ServerTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  token_use: typeof TOKEN_USE;
  /** organization id */
  org: string;
  /** product id */
  pid: string;
  /** client_id（产品凭证的对外标识） */
  cid: string;
  /** 授予的 scope 列表，业务端点按需检查 */
  scope: string[];
}

export interface IssuedServerToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  expires_at: string;
  scope: string[];
  issued_at: string;
  /** 签名用的 kid，客户端据此选公钥验签 */
  kid: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * 签发服务端访问令牌。
 * `ttlSeconds` 会被夹到 [60, 3600]，防止调用方申请一个十年有效的令牌。
 */
export async function issueServerToken(input: {
  identity: ServerIdentity;
  key: ActiveSigningKey;
  privateKeyRef: string;
  scope: string[];
  ttlSeconds?: number;
}): Promise<IssuedServerToken> {
  const ttl = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, 60), MAX_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const claims: ServerTokenClaims = {
    iss: ISSUER,
    aud: config.assertionAudience,
    sub: input.identity.credentialId,
    iat: now,
    exp: now + ttl,
    jti: `st_${randomBytes(12).toString("hex")}`,
    token_use: TOKEN_USE,
    org: input.identity.organizationId,
    pid: input.identity.productId,
    cid: input.identity.clientId,
    scope: [...new Set(input.scope)].sort(),
  };
  const header = { alg: "EdDSA", typ: "JWT", kid: input.key.kid };
  const signingInput = `${b64url(canonicalJson(header))}.${b64url(JSON.stringify(claims))}`;
  const privateKey = loadPrivateKey(input.privateKeyRef);
  const signature = signBytes(privateKey, Buffer.from(signingInput, "utf8"));

  return {
    access_token: `${signingInput}.${signature.toString("base64url")}`,
    token_type: "Bearer",
    expires_in: ttl,
    expires_at: new Date((now + ttl) * 1000).toISOString(),
    scope: claims.scope,
    issued_at: new Date(now * 1000).toISOString(),
    kid: input.key.kid,
  };
}

export type ServerTokenVerification =
  | { ok: true; identity: ServerIdentity; claims: ServerTokenClaims }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "expired" | "wrong_audience" };

/** 判断一段 Bearer JWT 是不是服务端访问令牌（而不是 client_assertion）。 */
export function looksLikeServerToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      token_use?: unknown;
    };
    return payload.token_use === TOKEN_USE;
  } catch {
    return false;
  }
}

/**
 * 校验服务端访问令牌。
 *
 * 顺序很重要：先按 header 里的 `kid` 找到公钥（`kid` 全局唯一），再用**库里的公钥**验签，
 * 最后才读 payload 里的 org/pid —— 验签之前 payload 是攻击者可控的数据，不能用于查库权限。
 */
export async function verifyServerToken(token: string): Promise<ServerTokenVerification> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: ServerTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ServerTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.token_use !== TOKEN_USE) return { ok: false, reason: "malformed" };

  const keyRow = await prisma.signing_keys.findUnique({
    where: { kid: header.kid },
    select: { id: true, public_key: true, status: true },
  });
  if (!keyRow) return { ok: false, reason: "unknown_key" };
  // retiring 仍可验签（轮换期旧令牌要能用），revoked 立刻失效。
  if (keyRow.status === "revoked") return { ok: false, reason: "unknown_key" };

  const { createPublicKey, verify: cryptoVerify } = await import("node:crypto");
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(keyRow.public_key), format: "der", type: "spki" });
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  const ok = cryptoVerify(
    null,
    Buffer.from(`${headerB64}.${payloadB64}`),
    key,
    Buffer.from(signatureB64, "base64url"),
  );
  if (!ok) return { ok: false, reason: "bad_signature" };

  if (claims.aud !== config.assertionAudience) return { ok: false, reason: "wrong_audience" };
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };

  return {
    ok: true,
    claims,
    identity: {
      organizationId: claims.org,
      productId: claims.pid,
      credentialId: claims.sub,
      clientId: claims.cid,
      subject: claims.sub,
    },
  };
}

/** 令牌指纹：只用于日志与排障，不参与鉴权。 */
export function serverTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, ISSUER, TOKEN_USE };