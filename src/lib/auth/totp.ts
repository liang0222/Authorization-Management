import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** TOTP（RFC 6238）实现：SHA-1 / 30 秒 / 6 位，用于管理员 MFA。 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = "";
  for (const byte of raw) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("无效的 Base32 密钥");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

import { createHmac } from "node:crypto";

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export function currentTotp(secret: string, at: Date = new Date()): string {
  return hotp(base32Decode(secret), Math.floor(at.getTime() / 1000 / 30));
}

/** 校验 6 位验证码，允许 ±1 个时间窗口（时钟漂移）。 */
export function verifyTotp(secret: string, code: string, at: Date = new Date()): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(at.getTime() / 1000 / 30);
  const key = base32Decode(secret);
  for (let delta = -1; delta <= 1; delta += 1) {
    if (hotp(key, counter + delta) === normalized) return true;
  }
  return false;
}

export function otpauthUri(secret: string, email: string, issuer = "子铭"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * 复制到独立的 ArrayBuffer 并返回 Uint8Array<ArrayBuffer>。
 * Prisma 7 的 Bytes 字段类型是 Uint8Array<ArrayBuffer>，Node 的 Buffer 是
 * Uint8Array<ArrayBufferLike>，两者不能直接赋值，因此统一在这里归一化。
 */
export function toPrismaBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy;
}

/** 会话/令牌哈希：只存摘要，不存明文。 */
export function sha256(input: string | Buffer): Uint8Array<ArrayBuffer> {
  return toPrismaBytes(createHash("sha256").update(input).digest());
}

/** 恒定时间比较两个字节序列（防时序侧信道）。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
