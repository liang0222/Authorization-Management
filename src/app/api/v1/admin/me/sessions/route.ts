import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";

/**
 * 当前管理员自己的登录会话列表。
 *
 * 为什么只查自己：会话是个人安全资产，管理员看别人的会话列表等于给了
 * 一份「谁在什么 IP 上登录」的侦查地图；组织级强制下线走成员禁用/改密。
 */
export async function GET(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId }) => {
    const rows = await prisma.admin_sessions.findMany({
      where: { user_id: session.user.id, revoked_at: null, expires_at: { gt: new Date() } },
      orderBy: [{ last_seen_at: "desc" }],
      take: 50,
      select: {
        id: true,
        ip: true,
        user_agent: true,
        created_at: true,
        last_seen_at: true,
        expires_at: true,
      },
    });

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          ip: row.ip,
          userAgent: row.user_agent,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          current: row.id === session.sessionId,
        })),
        total: rows.length,
      },
      requestId,
    );
  });
}

/** 一次撤销除当前会话以外的全部会话（改密之外的显式「全设备下线」）。 */
export async function DELETE(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId, ip, userAgent }) => {
    const result = await prisma.admin_sessions.updateMany({
      where: {
        user_id: session.user.id,
        id: { not: session.sessionId },
        revoked_at: null,
      },
      data: { revoked_at: new Date() },
    });
    if (result.count === 0) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "没有其他在线会话");
    }
    const { writeAudit } = await import("@/lib/domain/audit");
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "user.revoke_sessions",
      resourceType: "user",
      resourceId: session.user.id,
      after: { revoked: result.count },
      requestId,
      ip,
      userAgent,
    });
    return okResponse({ revoked: result.count }, requestId);
  });
}
