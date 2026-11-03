import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

/**
 * 授权码生成与存储（规格 2.3-E / 7.4）。
 *
 * - 使用 Crockford Base32 字母表（去掉 I/L/O/U，避免人工转录歧义）。
 * - 30 个字符 = 150 bit 熵，超过规格要求的 128 bit；数据库只存 HMAC-SHA-256。
 * - 明文仅在“创建/重发兑换码”响应中出现一次，之后任何接口都不再返回。
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_SIZE = 6;
const GROUP_COUNT = 5; // 30 字符
const KEY_LENGTH = GROUP_SIZE * GROUP_COUNT;

/** 均匀随机（拒绝采样，避免取模偏差）。 */
function randomChars(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      // 256 - (256 % 32) = 256，32 整除 256，无需拒绝；保留写法便于改字母表
      if (byte < 256 - (256 % ALPHABET.length)) {
        out.push(ALPHABET[byte % ALPHABET.length]);
        if (out.length === length) break;
      }
    }
  }
  return out.join("");
}

export function generateLicenseKey(): string {
  const raw = randomChars(KEY_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < KEY_LENGTH; i += GROUP_SIZE) {
    groups.push(raw.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

/** 归一化：大写、去掉分隔符与空白；Crockford 别名 I/L→1、O→0。 */
export function normalizeLicenseKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** HMAC-SHA-256(pepper, normalizedKey)，pepper 由 KMS/环境变量管理。 */
export function hashLicenseKey(
  input: string,
  pepper = config.licenseHmacPepper,
): Uint8Array<ArrayBuffer> {
  const normalized = normalizeLicenseKey(input);
  const digest = createHmac("sha256", pepper).update(normalized).digest();
  const copy = new Uint8Array(digest.byteLength);
  copy.set(digest);
  return copy;
}

/**
 * 当前 pepper + 只读旧 pepper（轮换用）。顺序即优先级。
 * 版本串会写进 `license_keys.hash_key_version`，便于审计“这一行是什么时候重算的”。
 */
export function licensePepperCandidates(): { version: string; pepper: string }[] {
  const candidates = [
    { version: config.licenseHmacPepperVersion, pepper: config.licenseHmacPepper },
  ];
  const legacy = config.licenseHmacPepperLegacy;
  if (legacy && !candidates.some((item) => item.pepper === legacy)) {
    candidates.push({ version: config.licenseHmacPepperLegacyVersion, pepper: legacy });
  }
  return candidates;
}

export function licenseKeyPrefix(input: string): string {
  return normalizeLicenseKey(input).slice(0, 8);
}

export function licenseKeyLast4(input: string): string {
  const normalized = normalizeLicenseKey(input);
  return normalized.slice(-4);
}

/** 列表展示用的脱敏形式。 */
export function maskLicenseKey(last4: string): string {
  return `••••-••••-••••-${last4}`;
}

export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** 产品凭证 client_id：前缀区分公开客户端/机密服务端。 */
export function generateClientId(kind: "public_client" | "confidential_server"): string {
  const prefix = kind === "public_client" ? "pc" : "cs";
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function generateClientSecret(): string {
  return `sk_${randomBytes(32).toString("base64url")}`;
}
