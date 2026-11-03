import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { hashPassword, passwordPolicyIssues } from "@/lib/auth/password";
import type { Prisma } from "@/generated/prisma/client";

/**
 * 组织成员（管理员）管理（规格 2.3-A、15.4 系统管理分组）。
 *
 * 设计决策：
 * - 成员 = organization_memberships，权限全部来自 roles + role_permissions；
 *   一个 users 记录可以属于多个组织，所以这里一律以 membership 为主键操作。
 * - 移除成员只把 membership.status 置为 disabled，不物理删除，保留审计线索；
 *   session 解析时会重新校验 membership.status，停用后旧会话立即失效。
 * - 组织只有一个所有者（owner）：邀请和调整角色都不允许产生第二个 owner。
 */

const MEMBER_STATUSES = ["active", "disabled"] as const;
type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** 成员列表统一返回结构：membership 为主键，附带 users / roles 摘要。 */
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

/** 用户复用时只读取这几个字段，创建分支保持完全一致的 select，避免类型分叉。 */
const userSummarySelect = {
  id: true,
  email: true,
  display_name: true,
  status: true,
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

/**
 * 一次性临时密码：16 位字母+数字。
 * 用密码策略本身做循环条件，保证生成值 100% 能通过 passwordPolicyIssues。
 */
function generateTempPassword(length = 16): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  for (;;) {
    let candidate = "";
    for (const byte of randomBytes(length)) candidate += alphabet[byte % alphabet.length];
    if (passwordPolicyIssues(candidate).length === 0) return candidate;
  }
}

export async function GET(req: NextRequest) {
  return withAdmin(req, "member:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const statusParam = url.searchParams.get("status");
    const status = MEMBER_STATUSES.includes(statusParam as MemberStatus)
      ? (statusParam as MemberStatus)
      : undefined;
    const roleCode = url.searchParams.get("roleCode")?.trim() || undefined;

    const where: Prisma.organization_membershipsWhereInput = {
      organization_id: session.organization.id,
      ...(status ? { status } : {}),
      ...(roleCode ? { roles: { code: roleCode } } : {}),
      // q 命中成员的姓名或邮箱：走 users 关系过滤，避免先查用户再二次过滤
      ...(query.q
        ? {
            users: {
              OR: [
                { display_name: { contains: query.q, mode: "insensitive" as const } },
                { email: { contains: query.q, mode: "insensitive" as const } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.organization_memberships.findMany({
        where,
        orderBy: { created_at: "asc" },
        skip: query.skip,
        take: query.pageSize,
        select: memberSelect,
      }),
      prisma.organization_memberships.count({ where }),
    ]);

    return okResponse(
      {
        items: rows.map(toMemberItem),
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
      },
      requestId,
    );
  });
}

const inviteSchema = z.object({
  email: z.string().trim().max(254).email("邮箱格式不正确"),
  displayName: z.string().trim().min(1, "请填写成员姓名").max(120),
  roleCode: z.string().trim().min(1, "请选择角色").max(80),
  /** 可选：管理员指定初始密码；不传则由服务端生成一次性随机密码。 */
  tempPassword: z.string().min(1).max(200).optional(),
});

export async function POST(req: NextRequest) {
  return withAdmin(req, "member:write", async ({ session, requestId, ip, userAgent }) => {
    const organizationId = session.organization.id;
    const body = await readJson(req, inviteSchema);
    const email = body.email.toLowerCase();

    // 管理员指定的初始密码同样要过密码策略，避免邀请链接被弱口令绕过
    if (body.tempPassword) {
      const issues = passwordPolicyIssues(body.tempPassword);
      if (issues.length > 0) {
        throw new ApiError(400, "INVALID_REQUEST", issues.join("；"), {
          fieldErrors: { tempPassword: issues.join("；") },
        });
      }
    }

    // 角色只在当前组织范围内查找：系统预设 owner/admin/operator/viewer 已按组织初始化
    const role = await prisma.roles.findFirst({
      where: { organization_id: organizationId, code: body.roleCode },
      select: { id: true, code: true, name: true },
    });
    if (!role) {
      throw new ApiError(400, "INVALID_REQUEST", "角色不存在", {
        fieldErrors: { roleCode: "角色不存在" },
      });
    }
    // 组织只有一个所有者：邀请流程禁止把新成员设为 owner
    if (role.code === "owner") {
      throw new ApiError(400, "INVALID_REQUEST", "组织只能有一个所有者，不能邀请新的 owner", {
        fieldErrors: { roleCode: "不能邀请为所有者" },
      });
    }

    const existingUser = await prisma.users.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: userSummarySelect,
    });

    // 同一组织同一用户只有一条 membership：已存在（含已停用）直接返回冲突，停用成员走 PATCH 恢复
    if (existingUser) {
      const existingMembership = await prisma.organization_memberships.findFirst({
        where: { organization_id: organizationId, user_id: existingUser.id },
        select: { id: true, status: true },
      });
      if (existingMembership) {
        throw new ApiError(409, "CONFLICT", "该邮箱已在组织中");
      }
    }

    // 只有新建账号才需要密码：复用既有账号时不重置对方密码（避免静默改密）
    const generatedPassword = existingUser ? null : (body.tempPassword ?? generateTempPassword());
    const passwordHash = generatedPassword ? await hashPassword(generatedPassword) : null;

    try {
      const result = await prisma.$transaction(async (tx) => {
        let user = existingUser;
        if (!user) {
          // 新建账号必须先有密码哈希（管理员指定或服务端生成），否则拒绝建号
          if (!passwordHash) {
            throw new ApiError(500, "INTERNAL_ERROR", "临时密码生成失败，请重试");
          }
          user = await tx.users.create({
            data: {
              email,
              password_hash: passwordHash,
              display_name: body.displayName,
              status: "active",
            },
            select: userSummarySelect,
          });
        } else if (user.status !== "active") {
          // 已存在但被停用的账号：邀请即重新启用，不新建重复用户
          user = await tx.users.update({
            where: { id: user.id },
            data: { status: "active", updated_at: new Date() },
            select: userSummarySelect,
          });
        }

        const membership = await tx.organization_memberships.create({
          data: {
            organization_id: organizationId,
            user_id: user.id,
            role_id: role.id,
          },
          select: memberSelect,
        });
        return { user, membership };
      });

      const membership = result.membership;

      // 审计绝不落密码明文：只记录是否复用账号、是否生成临时密码
      await writeAudit({
        organizationId,
        actorType: "admin",
        actorId: session.user.id,
        action: "member.invite",
        resourceType: "membership",
        resourceId: membership.id,
        after: {
          email,
          display_name: result.user.display_name,
          role_code: role.code,
          user_reused: Boolean(existingUser),
          temp_password_generated: Boolean(generatedPassword),
        },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          ...toMemberItem(membership),
          /** 仅当服务端生成临时密码时一次性返回；复用账号或管理员自带密码时为 null */
          tempPassword: generatedPassword,
          userReused: Boolean(existingUser),
        },
        requestId,
        { status: 201 },
      );
    } catch (error) {
      translatePrismaError(error, "该邮箱已在组织中");
    }
  });
}
