import { config } from "@/lib/config";
import { hashLicenseKey, licensePepperCandidates } from "@/lib/domain/license-key";
import { prisma } from "@/lib/db";

/**
 * 按明文授权码定位 `license_keys` 行，并顺带完成 pepper 轮换的“惰性重哈希”。
 *
 * 为什么需要它：授权码只存 HMAC，明文本就不在库里。换 pepper 后旧哈希再也算不出来，
 * 唯一能安全迁移的时刻就是“客户端带着明文来校验”的这一次。
 * 这里先用当前 pepper 查，再退到旧 pepper；命中旧 pepper 就地把该行改写为当前 pepper。
 *
 * 返回 id 而不是整行，是为了让调用方自己决定 include，避免这里塞一堆 Prisma 泛型。
 */
export interface LocatedLicenseKey {
  id: string;
  /** true 表示本次请求把该行从旧 pepper 升级到了当前 pepper。 */
  upgraded: boolean;
}

export async function locateLicenseKey(plaintext: string): Promise<LocatedLicenseKey | null> {
  for (const candidate of licensePepperCandidates()) {
    const row = await prisma.license_keys.findUnique({
      where: { key_hash: hashLicenseKey(plaintext, candidate.pepper) },
      select: { id: true },
    });
    if (!row) continue;

    const isCurrent =
      candidate.version === config.licenseHmacPepperVersion &&
      candidate.pepper === config.licenseHmacPepper;
    if (isCurrent) return { id: row.id, upgraded: false };

    try {
      await prisma.license_keys.update({
        where: { id: row.id },
        data: {
          key_hash: hashLicenseKey(plaintext),
          hash_key_version: config.licenseHmacPepperVersion,
        },
      });
      return { id: row.id, upgraded: true };
    } catch {
      // 并发请求可能刚刚升级过同一行：按 id 继续，本次校验照常进行。
      return { id: row.id, upgraded: false };
    }
  }
  return null;
}
