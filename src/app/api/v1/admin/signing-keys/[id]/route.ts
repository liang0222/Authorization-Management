import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

/**
 * 签名密钥状态机（规格 6.4）：
 *   staged → active → retiring → revoked，revoked 为终态。
 * - activate：只有 staged 可以激活（新建密钥已是 active，这条用于以后引入的预发布密钥）。
 * - retire：active 转入 retiring，旧公钥在验证窗口内继续可验已签发文件。
 * - revoke：staged/active/retiring 都可吊销，吊销后不可恢复，需要重新生成密钥。
 * 状态变更必须写审计（含操作者、时间、前后状态），私钥内容永不出现在审计里。
 */

type SigningKeyStatus = "staged" | "active" | "retiring" | "revoked";
type SigningKeyAction = "activate" | "retire" | "revoke";

const STATUS_BY_ACTION: Record<SigningKeyAction, SigningKeyStatus> = {
  activate: "active",
  retire: "retiring",
  revoke: "revoked",
};

/** 允许的迁移来源状态；revoked 不在任何来源里，天然是终态。 */
const ALLOWED_FROM: Record<SigningKeyAction, SigningKeyStatus[]> = {
  activate: ["staged"],
  retire: ["active"],
  revoke: ["staged", "active", "retiring"],
};

const patchSchema = z.object({
  action: z.enum(["activate", "retire", "revoke"]),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "signingkey:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);

    const key = await prisma.signing_keys.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, kid: true, status: true, algorithm: true, product_id: true },
    });
    if (!key) throw new ApiError(404, "RESOURCE_NOT_FOUND", "签名密钥不存在");

    if (key.status === "revoked") {
      throw new ApiError(409, "CONFLICT", "密钥已吊销，处于终态，无法再变更");
    }
    if (!ALLOWED_FROM[body.action].includes(key.status)) {
      throw new ApiError(
        409,
        "CONFLICT",
        `当前状态 ${key.status} 不能执行 ${body.action}（允许：${ALLOWED_FROM[body.action].join(", ")}）`,
      );
    }

    try {
      const updated = await prisma.signing_keys.update({
        where: { id },
        data: { status: STATUS_BY_ACTION[body.action] },
      });

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "signingkey.status",
        resourceType: "signing_key",
        resourceId: id,
        before: { kid: key.kid, status: key.status },
        after: { kid: updated.kid, status: updated.status, via: body.action },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          id: updated.id,
          kid: updated.kid,
          algorithm: updated.algorithm,
          status: updated.status,
          notBefore: updated.not_before.toISOString(),
          notAfter: updated.not_after?.toISOString() ?? null,
        },
        requestId,
      );
    } catch (error) {
      translatePrismaError(error, "签名密钥状态更新失败");
    }
  });
}
