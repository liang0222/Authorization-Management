import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

/**
 * 单个成员（organization_memberships.id）的角色与状态调整。
 *
 * 设计决策：
 * - owner 是组织的唯一所有者，这里禁止修改它的角色/状态，也禁止把别人提升为 owner。
 * - 移除成员 = status 置为 disabled，不删除记录；session 解析会重新校验 membership.status，
 *   所以停用后对方的现有会话会立即失效。
 * - 不允许管理员停用/移除自己，避免最后一名管理员把自己锁在系统外。
 */

const MEMBER_STATUSES = ["active", "disabled"] as const;
type MemberStatus = (typeof MEMBER_STATUSES)[number];

interface MemberRow {
  id: string;
  status: string;
  created_at: Date;
  users: {
    id: string;
    email: string;
    display_name: string;
    mfa_enabled: boolean;
    last_login_at: Date | null;
  };
  roles: { id: string; code: string; name: string };
}

const memberSelect = {
  id: true,
  status: true,
  created_at: true,
  users: {
    select: {
      id: true,
      email: true,
      display_name: true,
      mfa_enabled: true,
      last_login_at: true,
    },
  },
  roles: { select: { id: true, code: true, name: true } },
} as const;

function toMemberItem(row: MemberRow) {
  return {
    membershipId: row.id,
    userId: row.users.id,
    displayName: row.users.display_name,
    email: row.users.email,
    role: { id: row.roles.id, code: row.roles.code, name: row.roles.name },
    status: row.status,
    mfaEnabled: row.users.mfa_enabled,
    lastLoginAt: row.users.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const patchSchema = z.object({
  roleCode: z.string().trim().min(1, "角色编码不能为空").max(80).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "member:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const organizationId = session.organization.id;
    const body = await readJson(req, patchSchema);

    if (body.roleCode === undefined && body.status === undefined) {
      throw new ApiError(400, "INVALID_REQUEST", "至少需要修改角色或状态");
    }

    const membership = await prisma.organization_memberships.findFirst({
      where: { id, organization_id: organizationId },
      select: memberSelect,
    });
    if (!membership) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "成员不存在或不属于当前组织");
    }
    if (membership.roles.code === "owner") {
      throw new ApiError(403, "FORBIDDEN", "所有者成员的角色与状态不可修改");
    }
    if (membership.users.id === session.user.id && body.status === "disabled") {
      throw new ApiError(400, "INVALID_REQUEST", "不能停用自己的成员身份，请由其他管理员操作");
    }

    let nextRole = membership.roles;
    if (body.roleCode !== undefined && body.roleCode !== membership.roles.code) {
      const role = await prisma.roles.findFirst({
        where: { organization_id: organizationId, code: body.roleCode },
        select: { id: true, code: true, name: true },
      });
      if (!role) {
        throw new ApiError(400, "INVALID_REQUEST", "角色不存在", {
          fieldErrors: { roleCode: "角色不存在" },
        });
      }
      // 组织只有一个所有者：调整角色时也不允许把其他人提升为 owner
      if (role.code === "owner") {
        throw new ApiError(403, "FORBIDDEN", "不能把成员提升为所有者：组织只有一个所有者");
      }
      nextRole = role;
    }

    const data: { role_id?: string; status?: MemberStatus } = {};
    if (nextRole.id !== membership.roles.id) data.role_id = nextRole.id;
    if (body.status !== undefined && body.status !== membership.status) data.status = body.status;

    if (Object.keys(data).length === 0) {
      // 没有任何实际变化：不写库也不写审计，保持审计日志只记录真实变更
      return okResponse({ ...toMemberItem(membership), changed: false }, requestId);
    }

    const updated = await prisma.organization_memberships.update({
      where: { id },
      data,
      select: memberSelect,
    });

    if (data.role_id) {
      await writeAudit({
        organizationId,
        actorType: "admin",
        actorId: session.user.id,
        action: "member.update_role",
        resourceType: "membership",
        resourceId: id,
        before: { role_code: membership.roles.code, role_name: membership.roles.name },
        after: { role_code: updated.roles.code, role_name: updated.roles.name },
        requestId,
        ip,
        userAgent,
      });
    }
    if (data.status) {
      await writeAudit({
        organizationId,
        actorType: "admin",
        actorId: session.user.id,
        action: "member.status_change",
        resourceType: "membership",
        resourceId: id,
        before: { status: membership.status },
        after: { status: updated.status },
        requestId,
        ip,
        userAgent,
      });
    }

    return okResponse({ ...toMemberItem(updated), changed: true }, requestId);
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "member:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const organizationId = session.organization.id;

    const membership = await prisma.organization_memberships.findFirst({
      where: { id, organization_id: organizationId },
      select: memberSelect,
    });
    if (!membership) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "成员不存在或不属于当前组织");
    }
    if (membership.roles.code === "owner") {
      throw new ApiError(403, "FORBIDDEN", "所有者成员不可被移除");
    }
    if (membership.users.id === session.user.id) {
      throw new ApiError(400, "INVALID_REQUEST", "不能移除自己的成员身份，请由其他管理员操作");
    }

    // 已是停用状态：幂等返回成功，不重复写审计
    if (membership.status === "disabled") {
      return okResponse(
        { removed: true, alreadyDisabled: true, membershipId: id, status: membership.status },
        requestId,
      );
    }

    const updated = await prisma.organization_memberships.update({
      where: { id },
      data: { status: "disabled" },
      select: { id: true, status: true },
    });

    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: session.user.id,
      action: "member.remove",
      resourceType: "membership",
      resourceId: id,
      before: { status: membership.status, role_code: membership.roles.code },
      after: { status: updated.status },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      { removed: true, alreadyDisabled: false, membershipId: id, status: updated.status },
      requestId,
    );
  });
}
