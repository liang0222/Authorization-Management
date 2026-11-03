import { createHash } from "node:crypto";
import { sealSecret } from "@/lib/auth/secretbox";
import { toPrismaBytes } from "@/lib/auth/totp";
import type { Prisma } from "@/generated/prisma/client";
import type { CredentialPayload } from "./schemas";

/**
 * 存储凭证的写入（规格 16.11.2：凭证单独建表 + envelope encryption）。
 *
 * - 明文只在这一次请求的内存里出现，落库前就 `sealSecret` 封成密文；
 * - `fingerprint` 是可公开的短摘要（kind + 标识符），用来在界面上区分「换没换过」，
 *   它不足以还原凭证本身；
 * - 换凭证走「新建 + 吊销旧的」，不原地覆盖 —— 保留轮换历史，出问题能回溯（规格要求 rotated_at/revoked_at）。
 */
export function credentialFingerprint(payload: CredentialPayload): string {
  const identifier =
    payload.kind === "access_key"
      ? payload.accessKeyId
      : payload.username;
  return createHash("sha256").update(`${payload.kind}:${identifier}`).digest("hex").slice(0, 16);
}

export async function createCredential(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; destinationId: string; payload: CredentialPayload },
): Promise<{ id: string; fingerprint: string }> {
  const sealed = sealSecret(JSON.stringify(input.payload));
  const fingerprint = credentialFingerprint(input.payload);
  const row = await tx.backup_storage_credentials.create({
    data: {
      organization_id: input.organizationId,
      destination_id: input.destinationId,
      ciphertext: toPrismaBytes(Buffer.from(sealed, "utf8")),
      algorithm: "aes-256-gcm",
      key_version: 1,
      fingerprint,
    },
    select: { id: true },
  });
  return { id: row.id, fingerprint };
}

export async function revokeCredential(tx: Prisma.TransactionClient, credentialId: string): Promise<void> {
  await tx.backup_storage_credentials.update({
    where: { id: credentialId },
    data: { revoked_at: new Date(), rotated_at: new Date() },
  });
}
