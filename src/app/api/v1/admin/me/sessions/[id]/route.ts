import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

/** 撤销指定的一个会话。只能撤销自己的，防止越权下线他人。 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withAdmin(req, null, async ({ session, requestId, ip, userAgent }) => {
    if (id === session.sessionId) {
      throw new ApiError(400, "INVALID_REQUEST", "不能撤销当前正在使用的会话，请直接退出登录");
    }
    const row = await prisma.admin_sessions.findFirst({
      where: { id, user_id: session.user.id },
      select: { id: true, revoked_at: true },
    });
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "会话不存在");
    if (row.revoked_at) throw new ApiError(409, "CONFLICT", "该会话已撤销");

    await prisma.admin_sessions.update({ where: { id: row.id }, data: { revoked_at: new Date() } });
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "user.revoke_session",
      resourceType: "user_session",
      resourceId: row.id,
      requestId,
      ip,
      userAgent,
    });
    return okResponse({ revoked: true }, requestId);
  });
}
