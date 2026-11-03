import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

/**
 * 备份包加密（规格 16.x：备份必须加密，且密钥不能与备份放同一位置）。
 *
 * 格式：`ZMBK1` + 12 字节 IV + 16 字节 GCM tag + 密文。
 * 头部魔数让「拿错文件」能在解密前就被拦住，而不是解出一堆乱码再报错。
 */
const MAGIC = Buffer.from("ZMBK1", "ascii");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyBuffer(): Buffer {
  // 生产必须显式设置 BACKUP_ENCRYPTION_KEY；开发默认从 sessionSecret 派生，
  // 这样本地无需额外配置，而生产漏配会被 productionSafetyIssues 拦住。
  return createHash("sha256").update(config.backupEncryptionKey).digest();
}

export function encryptBackup(payload: Buffer): { body: Buffer; sha256: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const body = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  return { body, sha256: createHash("sha256").update(body).digest("hex") };
}

export function decryptBackup(body: Buffer): Buffer {
  if (body.length < MAGIC.length + IV_LENGTH + TAG_LENGTH || !body.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("不是有效的子铭备份包（魔数不匹配）");
  }
  const iv = body.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = body.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
  const ciphertext = body.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(), iv);
  decipher.setAuthTag(tag);
  // GCM 的 tag 校验失败会在这里抛错——密文被篡改一个字节也过不去。
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
