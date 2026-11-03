import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import {
  ALL_PERMISSION_CODES,
  PERMISSIONS,
  ROLE_PRESETS,
} from "@/lib/domain/permissions";

/**
 * 组织角色总览 + 自定义角色创建（规格 2.3-A、15.4）。
 *
 * 设计决策：
 * - roles 按组织隔离（roles.organization_id）；系统预设 owner/admin/operator/viewer
 *   在组织初始化时已写入，is_system=true。
 * - 某些历史/自定义角色的 role_permissions 可能为空：这里按 ROLE_PRESETS 同 code 的预设
 *   “补齐显示”，只读派生，不回写数据库（标记 permissionsDerived=true 供前端提示）。
 * - 角色编码白名单只在 ALL_PERMISSION_CODES 内，避免写出前端/后端都不认识的权限码。
 */

const roleCodeSchema = z
  .string()
  .trim()
  .min(2, "角色编码至少 2 个字符")
  .max(80)
  .regex(/^[a-z][a-z0-9_-]*$/, "角色编码只能包含小写字母、数字、- 和 _，且必须以字母开头");

const createRoleSchema = z.object({
  code: roleCodeSchema,
  name: z.string().trim().min(1, "请填写角色名称").max(120),
  permissionCodes: z
    .array(z.string().trim().min(1).max(120))
    .min(1, "请至少选择一项权限")
    .max(ALL_PERMISSION_CODES.length),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "member:read", async ({ session, requestId }) => {
    const organizationId = session.organization.id;

    const [roles, membershipCounts] = await Promise.all([
      prisma.roles.findMany({
        where: { organization_id: organizationId },
        orderBy: [{ is_system: "desc" }, { code: "asc" }],
        select: {
          id: true,
          code: true,
          name: true,
          is_system: true,
          created_at: true,
          role_permissions: { select: { permission_code: true } },
        },
      }),
      // 一次 groupBy 同时拿到“全部成员数”和“启用中成员数”，避免每个角色各查一次
      prisma.organization_memberships.groupBy({
        by: ["role_id", "status"],
        where: { organization_id: organizationId },
        _count: { _all: true },
      }),
    ]);

    const countMap = new Map<string, { total: number; active: number }>();
    for (const row of membershipCounts) {
      const current = countMap.get(row.role_id) ?? { total: 0, active: 0 };
      current.total += row._count._all;
      if (row.status === "active") current.active += row._count._all;
      countMap.set(row.role_id, current);
    }

    const items = roles.map((role) => {
      const preset = ROLE_PRESETS.find((item) => item.code === role.code);
      const explicit = role.role_permissions.map((row) => row.permission_code);
      // role_permissions 为空时按同 code 的预设派生，仅用于展示，不写库
      const derived = explicit.length === 0 ? (preset?.permissions ?? []) : [];
      const permissionCodes = Array.from(new Set([...explicit, ...derived])).sort();
      const counts = countMap.get(role.id) ?? { total: 0, active: 0 };
      return {
        id: role.id,
        code: role.code,
        name: role.name,
        description: preset?.description ?? null,
        isSystem: role.is_system,
        isPreset: Boolean(preset),
        permissionCodes,
        /** true 表示该角色没有显式 role_permissions，权限列表是按预设补齐的 */
        permissionsDerived: explicit.length === 0 && derived.length > 0,
        memberCount: counts.total,
        activeMemberCount: counts.active,
        createdAt: role.created_at.toISOString(),
      };
    });

    return okResponse(
      {
        items,
        // 角色是低基数配置数据，一次性返回全部；分页字段按“单页返回全部”如实填写
        page: 1,
        pageSize: Math.max(1, items.length),
        total: items.length,
        pageCount: 1,
        // 角色编辑器需要的权限目录（与 PERMISSIONS 定义同源，避免前端硬编码）
        availablePermissions: PERMISSIONS.map((permission) => ({
          code: permission.code,
          description: permission.description,
          group: permission.group,
        })),
      },
      requestId,
    );
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "member:write", async ({ session, requestId, ip, userAgent }) => {
    const organizationId = session.organization.id;
    const body = await readJson(req, createRoleSchema);
    const permissionCodes = Array.from(new Set(body.permissionCodes));

    // 白名单校验：只接受 PERMISSIONS 目录里存在的权限码
    const unknown = permissionCodes.filter((code) => !ALL_PERMISSION_CODES.includes(code));
    if (unknown.length > 0) {
      const message = `存在未定义的权限码：${unknown.join("、")}`;
      throw new ApiError(400, "INVALID_REQUEST", message, {
        fieldErrors: { permissionCodes: message },
      });
    }

    // 预设角色编码不能被自定义角色占用，否则按 code 推导权限时会与系统语义冲突
    if (ROLE_PRESETS.some((preset) => preset.code === body.code)) {
      throw new ApiError(409, "CONFLICT", "该角色编码与系统预设角色重复");
    }

    const existing = await prisma.roles.findFirst({
      where: { organization_id: organizationId, code: body.code },
      select: { id: true },
    });
    if (existing) {
      throw new ApiError(409, "CONFLICT", "该角色编码已存在");
    }

    // permissions 表是权限码的白名单镜像：先确认全部存在，避免 createMany 触发外键错误
    const knownPermissions = await prisma.permissions.findMany({
      where: { code: { in: permissionCodes } },
      select: { code: true },
    });
    const knownSet = new Set(knownPermissions.map((row) => row.code));
    const missing = permissionCodes.filter((code) => !knownSet.has(code));
    if (missing.length > 0) {
      const message = `权限目录未同步以下权限码：${missing.join("、")}`;
      throw new ApiError(400, "INVALID_REQUEST", message, {
        fieldErrors: { permissionCodes: message },
      });
    }

    try {
      const role = await prisma.$transaction(async (tx) => {
        const created = await tx.roles.create({
          data: {
            organization_id: organizationId,
            code: body.code,
            name: body.name,
            is_system: false,
          },
        });
        await tx.role_permissions.createMany({
          data: permissionCodes.map((code) => ({
            role_id: created.id,
            permission_code: code,
          })),
        });
        return created;
      });

      await writeAudit({
        organizationId,
        actorType: "admin",
        actorId: session.user.id,
        action: "role.create",
        resourceType: "role",
        resourceId: role.id,
        after: {
          code: role.code,
          name: role.name,
          permission_codes: permissionCodes,
        },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          id: role.id,
          code: role.code,
          name: role.name,
          isSystem: false,
          permissionCodes,
          createdAt: role.created_at.toISOString(),
        },
        requestId,
        { status: 201 },
      );
    } catch (error) {
      translatePrismaError(error, "该角色编码已存在");
    }
  });
}
