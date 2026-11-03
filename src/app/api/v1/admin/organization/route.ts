import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

/**
 * 当前组织信息（规格 2.3-A、15.4“系统管理 / 组织设置”）。
 *
 * 设计决策：
 * - 组织上下文永远来自会话（session.organization.id），不接受请求体传入组织 ID，
 *   避免越权读取/修改其他组织。
 * - 时区只允许是合法 IANA 时区（用 Intl 校验）；时区仅影响后续签发与后台展示，
 *   已签发授权的期限是签发时的快照，不会被追溯修改。
 */

const patchSchema = z.object({
  name: z.string().trim().min(1, "请填写组织名称").max(160).optional(),
  timezone: z.string().trim().min(1, "请选择时区").max(64).optional(),
});

/** Intl 是运行时最可靠的 IANA 时区校验器：非法时区会抛 RangeError。 */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 修改时区时必须提示：授权期限是快照，不会被时区变更追溯影响。 */
const TIMEZONE_NOTICE = "修改时区不会改变已签发授权的期限快照；仅影响后续签发的授权与后台时间展示。";

export async function GET(req: NextRequest) {
  return withAdmin(req, "org:read", async ({ session, requestId }) => {
    const organizationId = session.organization.id;
    const organization = await prisma.organizations.findFirst({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        status: true,
        settings: true,
        created_at: true,
        updated_at: true,
        _count: { select: { organization_memberships: true, products: true } },
      },
    });
    if (!organization) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "组织不存在");
    }

    // 成员数区分“全部”和“启用中”，停用成员仍保留记录（软删除）
    const activeMemberCount = await prisma.organization_memberships.count({
      where: { organization_id: organizationId, status: "active" },
    });

    return okResponse(
      {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        timezone: organization.timezone,
        status: organization.status,
        settings: organization.settings,
        createdAt: organization.created_at.toISOString(),
        updatedAt: organization.updated_at.toISOString(),
        memberCount: organization._count.organization_memberships,
        activeMemberCount,
        productCount: organization._count.products,
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest) {
  return withAdmin(req, "org:write", async ({ session, requestId, ip, userAgent }) => {
    const organizationId = session.organization.id;
    const body = await readJson(req, patchSchema);

    if (body.name === undefined && body.timezone === undefined) {
      throw new ApiError(400, "INVALID_REQUEST", "至少需要修改组织名称或时区");
    }
    if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
      throw new ApiError(400, "INVALID_REQUEST", "时区不合法，请填写 IANA 时区（如 Asia/Shanghai）", {
        fieldErrors: { timezone: `无法识别时区：${body.timezone}` },
      });
    }

    const before = await prisma.organizations.findFirst({
      where: { id: organizationId },
      select: { id: true, name: true, timezone: true },
    });
    if (!before) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "组织不存在");
    }

    const updated = await prisma.organizations.update({
      where: { id: organizationId },
      data: {
        name: body.name,
        timezone: body.timezone,
        updated_at: new Date(),
      },
      select: { id: true, name: true, slug: true, timezone: true, status: true, updated_at: true },
    });

    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: session.user.id,
      action: "organization.update",
      resourceType: "organization",
      resourceId: organizationId,
      before: { name: before.name, timezone: before.timezone },
      after: { name: updated.name, timezone: updated.timezone },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        timezone: updated.timezone,
        status: updated.status,
        updatedAt: updated.updated_at.toISOString(),
        /** 时区变更时明确告知：授权期限不会被追溯改变 */
        notice: body.timezone === undefined ? null : TIMEZONE_NOTICE,
      },
      requestId,
    );
  });
}
