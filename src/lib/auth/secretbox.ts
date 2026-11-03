import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

/**
 * 对称加密（AES-256-GCM），用于 MFA 密钥、Webhook 签名密钥、备份存储凭证
 * 这类“必须可逆”的少量机密。
 *
 * 密钥环设计（规格 17「生产密钥轮换」）：
 * - 新加密只用 `config.secretboxKey`（可用 SECRETBOX_KEY 独立设置）；
 * - 解密按 `secretboxKey → SECRETBOX_KEYS_LEGACY...` 顺序尝试，
 *   所以换密钥不会让存量密文变成永久乱码；
 * - 旧密钥只读，不进 `sealSecret`，避免新旧混写。
 */

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(`secretbox:${secret}`).digest();
}

/** 纯函数版本，便于单测直接验证密钥轮换行为。 */
export function sealWithKey(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** 依次尝试每个密钥；全部失败时抛最后一个错误（GCM 校验失败）。 */
export function openWithKeys(secrets: string[], sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 28) throw new Error("secretbox: 密文长度不足");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  let lastError: unknown = null;
  const tried = new Set<string>();
  for (const secret of secrets) {
    if (!secret || tried.has(secret)) continue;
    tried.add(secret);
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("secretbox: 无法解密");
}

export function sealSecret(plaintext: string): string {
  return sealWithKey(config.secretboxKey, plaintext);
}

export function openSecret(sealed: string): string {
  return openWithKeys([config.secretboxKey, ...config.secretboxLegacyKeys], sealed);
}
