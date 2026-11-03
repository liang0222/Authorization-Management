import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

/**
 * 激活访问令牌（短期、可轮换）。
 *
 * 设计取舍：第一阶段的公开客户端使用「设备挑战签名 + 服务端签发的短期 Bearer Token」，
 * 而不是完整 DPoP（RFC 9449）。令牌只含不敏感标识与版本号，签名密钥由 SESSION_SECRET 派生；
 * 服务端通过 activations.token_version 实现令牌轮换与重放失效。
 */

const TOKEN_SECRET = createHash("sha256")
  .update(`activation-token:${config.sessionSecret}`)
  .digest();

export interface ActivationTokenPayload {
  /** activation id */
  aid: string;
  /** device id */
  did: string;
  /** product id */
  pid: string;
  /** organization id */
  org: string;
  /** token version，与服务端记录不一致即失效 */
  ver: number;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(body: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
}

export function issueActivationToken(
  payload: Omit<ActivationTokenPayload, "iat" | "exp">,
  ttlSeconds = 600,
): { token: string; expiresAt: Date } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const full: ActivationTokenPayload = {
    ...payload,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const body = b64url(JSON.stringify(full));
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(full.exp * 1000) };
}

export type TokenVerification =
  | { ok: true; payload: ActivationTokenPayload }
  | { ok: false; reason: "malformed" | "invalid_signature" | "expired" };

export function verifyActivationToken(token: string | null | undefined): TokenVerification {
  if (!token) return { ok: false, reason: "malformed" };
  const [body, signature] = token.split(".");
  if (!body || !signature) return { ok: false, reason: "malformed" };

  const expected = sign(body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: ActivationTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ActivationTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload.aid || !payload.did || !payload.pid || !payload.org) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** 设备签名挑战的规范化消息（必须与 SDK 文档一致，禁止各平台自行拼接）。 */
/**
 * 规范化挑战消息的版本前缀（规格 27.8）。
 *
 * 硬约束：这是**写死在客户端**的字符串。SDK 一旦发布，改动等于全网升级，
 * 所以 v1 首行必须是这个常量，且除最后一行外每行一个 LF、末尾不额外加 LF。
 */
export const CANONICAL_CHALLENGE_PREFIX = "LICENSE-ACTIVATION-CHALLENGE-V1";

export type CanonicalVersion = "v1" | "legacy";

/**
 * v1（规格 27.8，当前标准）：6 行，首行为版本前缀。
 *
 * ```text
 * LICENSE-ACTIVATION-CHALLENGE-V1
 * {challenge_id}
 * {nonce}
 * {product_id}
 * {device_instance_id}
 * {expires_at}
 * ```
 */
export function canonicalChallengeMessageV1(input: {
  challengeId: string;
  nonce: string;
  productId: string;
  deviceInstanceId: string;
  expiresAt: string;
}): string {
  return `${CANONICAL_CHALLENGE_PREFIX}\n${canonicalChallengeMessage(input)}`;
}

/**
 * legacy（v1.4 及更早的实现）：只有 5 个字段，没有版本前缀。
 * 保留它是为了 v1.5 之前的客户端继续可用，新 SDK 不应使用。
 */
export function canonicalChallengeMessage(input: {
  challengeId: string;
  nonce: string;
  productId: string;
  deviceInstanceId: string;
  expiresAt: string;
}): string {
  return [
    input.challengeId,
    input.nonce,
    input.productId,
    input.deviceInstanceId,
    input.expiresAt,
  ].join("\n");
}

/** 按版本取规范化消息；服务端验签时两个版本都要能算出来。 */
export function canonicalChallengeMessageFor(
  version: CanonicalVersion,
  input: {
    challengeId: string;
    nonce: string;
    productId: string;
    deviceInstanceId: string;
    expiresAt: string;
  },
): string {
  return version === "v1" ? canonicalChallengeMessageV1(input) : canonicalChallengeMessage(input);
}
