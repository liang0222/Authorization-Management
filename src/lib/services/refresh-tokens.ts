import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { toPrismaBytes } from "@/lib/auth/totp";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Refresh Token（规格 4.7 / 4.8）。
 *
 * 设计要点：
 * - **只返回一次**，数据库只存 SHA-256 哈希（`activation_refresh_tokens.token_hash`）。
 * - 每次心跳都轮换：旧令牌 `used_at` 打戳并 `replaced_by` 指向新令牌。
 * - 同一 family 内旧令牌再次出现 = 重放：整族吊销并写 `activation_events` 安全事件。
 * - 令牌是不透明随机串，不含任何可解析信息。
 */

const REFRESH_PREFIX = "rt_";

/** 生成不透明 refresh token（43 字节 base64url 随机，前缀便于日志识别与脱敏）。 */
export function newRefreshToken(): string {
  return `${REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** 令牌哈希：SHA-256，落库为 bytea（Prisma 7 要求 ArrayBuffer 视图）。 */
export function hashRefreshToken(token: string): Uint8Array<ArrayBuffer> {
  return toPrismaBytes(createHash("sha256").update(token, "utf8").digest());
}

type Tx = Prisma.TransactionClient;

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
  familyId: string;
}

/** 在给定事务内签发一枚新的 refresh token（可指定 family 以延续同一族）。 */
export async function issueRefreshToken(
  tx: Tx,
  input: { organizationId: string; activationId: string; ttlSeconds: number; familyId?: string },
): Promise<IssuedRefreshToken> {
  const token = newRefreshToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  const familyId = input.familyId ?? randomUUID();
  await tx.activation_refresh_tokens.create({
    data: {
      organization_id: input.organizationId,
      activation_id: input.activationId,
      token_family_id: familyId,
      token_hash: hashRefreshToken(token),
      expires_at: expiresAt,
    },
  });
  return { token, expiresAt, familyId };
}

export interface RotatedRefreshToken {
  token: string;
  expiresAt: Date;
  familyId: string;
  activationId: string;
  organizationId: string;
}

export type RotateOutcome =
  | ({ ok: true } & RotatedRefreshToken)
  | { ok: false; reason: "invalid" | "revoked" | "expired" | "replay"; activationId: string | null };

/**
 * 轮换 refresh token：校验存在性 → 检测重放 → 打戳旧令牌 → 同族签发新令牌。
 *
 * 重放判定：命中记录已有 `used_at`。此时同一枚令牌被用了第二次，说明可能被盗用，
 * 按规格吊销整个 family 并记录安全事件。
 *
 * **为什么返回结果而不是直接抛错**：重放处理要吊销整族，如果在这里 `throw`，
 * 外层 `prisma.$transaction` 会回滚——吊销动作本身被撤销，攻击者手里的旧令牌反而继续有效。
 * 所以这里只把结果带回，由调用方在事务提交之后再抛 401。
 */
export async function rotateRefreshToken(
  tx: Tx,
  input: { token: string; organizationId: string; ttlSeconds: number },
): Promise<RotateOutcome> {
  const row = await tx.activation_refresh_tokens.findUnique({
    where: { token_hash: hashRefreshToken(input.token) },
  });
  if (!row || row.organization_id !== input.organizationId) {
    return { ok: false, reason: "invalid", activationId: null };
  }
  if (row.revoked_at) {
    return { ok: false, reason: "revoked", activationId: row.activation_id };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: "expired", activationId: row.activation_id };
  }

  if (row.used_at) {
    // 重放：整族吊销。不做「只拒绝本次」的温和处理——那等于放过一次凭证泄露。
    await tx.activation_refresh_tokens.updateMany({
      where: { token_family_id: row.token_family_id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    await tx.activation_events.create({
      data: {
        organization_id: row.organization_id,
        activation_id: row.activation_id,
        event_type: "activation.blocked",
        actor_type: "system",
        details: { reason: "refresh_token_replay", family_id: row.token_family_id },
      },
    });
    return { ok: false, reason: "replay", activationId: row.activation_id };
  }

  const issued = await issueRefreshToken(tx, {
    organizationId: row.organization_id,
    activationId: row.activation_id,
    ttlSeconds: input.ttlSeconds,
    familyId: row.token_family_id,
  });

  const created = await tx.activation_refresh_tokens.findUnique({
    where: { token_hash: hashRefreshToken(issued.token) },
    select: { id: true },
  });
  await tx.activation_refresh_tokens.update({
    where: { id: row.id },
    data: { used_at: new Date(), replaced_by: created?.id ?? null },
  });

  return {
    ok: true,
    token: issued.token,
    expiresAt: issued.expiresAt,
    familyId: issued.familyId,
    activationId: row.activation_id,
    organizationId: row.organization_id,
  };
}

/** 吊销一次激活名下的全部 refresh token（解绑/管理员吊销时调用）。 */
export async function revokeRefreshTokensForActivation(
  tx: Tx,
  input: { organizationId: string; activationId: string },
): Promise<number> {
  const result = await tx.activation_refresh_tokens.updateMany({
    where: {
      organization_id: input.organizationId,
      activation_id: input.activationId,
      revoked_at: null,
    },
    data: { revoked_at: new Date() },
  });
  return result.count;
}

/** 清理过期令牌（由维护任务调用；同步删除，不做软删）。 */
export async function pruneExpiredRefreshTokens(): Promise<number> {
  const result = await prisma.activation_refresh_tokens.deleteMany({
    where: { expires_at: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } },
  });
  return result.count;
}
