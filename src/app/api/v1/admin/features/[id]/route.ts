import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

/**
 * 单个功能定义的修改与归档（规格 2.3-B）。
 *
 * 设计决策：
 * - 只允许改 name / description / defaultValue / status；code 与 value_type 一旦被套餐、
 *   授权引用就不能悄悄改语义（改类型需要新建功能并迁移数据）。
 * - defaultValue 必须与 value_type 匹配：boolean / number / string 严格校验，json 接受任意
 *   可序列化值（与产品功能创建接口支持的类型保持一致）。
 * - 删除 = status 置为 archived（软删除），并且已被套餐或授权引用时直接 409，避免
 *   存量的 plan_features / license_features 失去功能定义。
 */

const FEATURE_STATUSES = ["active", "disabled", "archived"] as const;

const patchSchema = z.object({
  name: z.string().trim().min(1, "请填写功能名称").max(160).optional(),
  description: z.string().max(2000).nullish(),
  defaultValue: z.unknown().optional(),
  status: z.enum(FEATURE_STATUSES).optional(),
});

/** 按 value_type 校验默认值，错误信息直接给到前端字段级提示。 */
function assertDefaultValue(valueType: string, value: unknown): void {
  const invalid = (message: string) => {
    throw new ApiError(400, "INVALID_REQUEST", message, {
      fieldErrors: { defaultValue: message },
    });
  };
  switch (valueType) {
    case "boolean":
      if (typeof value !== "boolean") invalid("该功能的默认值必须是布尔值（true/false）");
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) invalid("该功能的默认值必须是数字");
      return;
    case "string":
      if (typeof value !== "string") invalid("该功能的默认值必须是字符串");
      return;
    case "json":
      // json 类型允许对象/数组等结构化默认值，只要求能被 JSON 序列化
      if (value === undefined) invalid("该功能的默认值不能为空");
      return;
    default:
      invalid(`未知的功能值类型：${valueType}`);
  }
}

const featureSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  value_type: true,
  default_value: true,
  status: true,
  product_id: true,
  created_at: true,
  products: { select: { id: true, name: true, code: true } },
} as const;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "feature:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const organizationId = session.organization.id;
    const body = await readJson(req, patchSchema);

    if (
      body.name === undefined &&
      body.description === undefined &&
      body.defaultValue === undefined &&
      body.status === undefined
    ) {
      throw new ApiError(400, "INVALID_REQUEST", "至少需要修改一项内容");
    }

    const before = await prisma.product_features.findFirst({
      where: { id, organization_id: organizationId },
      select: { id: true, code: true, value_type: true, default_value: true, name: true, description: true, status: true },
    });
    if (!before) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "功能定义不存在或不属于当前组织");
    }

    if (body.defaultValue !== undefined) {
      assertDefaultValue(before.value_type, body.defaultValue);
    }

    const updated = await prisma.product_features.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description === undefined ? undefined : body.description,
        default_value: body.defaultValue === undefined ? undefined : (body.defaultValue as never),
        status: body.status,
      },
      select: featureSelect,
    });

    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: session.user.id,
      action: "feature.update",
      resourceType: "product_feature",
      resourceId: id,
      before: {
        name: before.name,
        description: before.description,
        default_value: before.default_value,
        status: before.status,
      },
      after: {
        name: updated.name,
        description: updated.description,
        default_value: updated.default_value,
        status: updated.status,
      },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      {
        id: updated.id,
        code: updated.code,
        name: updated.name,
        description: updated.description,
        valueType: updated.value_type,
        defaultValue: updated.default_value,
        status: updated.status,
        product: { id: updated.products.id, name: updated.products.name, code: updated.products.code },
        createdAt: updated.created_at.toISOString(),
      },
      requestId,
    );
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "feature:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const organizationId = session.organization.id;

    const feature = await prisma.product_features.findFirst({
      where: { id, organization_id: organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        product_id: true,
      },
    });
    if (!feature) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "功能定义不存在或不属于当前组织");
    }

    // 引用计数以 (product_id, code) 定位，避免同名 code 在其他产品下被误算
    const [planCount, licenseCount] = await Promise.all([
      prisma.plan_features.count({
        where: { organization_id: organizationId, product_id: feature.product_id, feature_code: feature.code },
      }),
      prisma.license_features.count({
        where: { organization_id: organizationId, product_id: feature.product_id, feature_code: feature.code },
      }),
    ]);

    if (planCount > 0 || licenseCount > 0) {
      throw new ApiError(
        409,
        "CONFLICT",
        `该功能已被 ${planCount} 个套餐、${licenseCount} 条授权引用，无法归档`,
        { planCount, licenseCount },
      );
    }

    if (feature.status === "archived") {
      // 幂等：已归档直接返回成功，不重复写审计
      return okResponse(
        { archived: true, alreadyArchived: true, id: feature.id, code: feature.code, status: feature.status },
        requestId,
      );
    }

    const updated = await prisma.product_features.update({
      where: { id },
      data: { status: "archived" },
      select: { id: true, code: true, status: true },
    });

    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: session.user.id,
      action: "feature.archive",
      resourceType: "product_feature",
      resourceId: id,
      before: { status: feature.status, code: feature.code, name: feature.name },
      after: { status: updated.status },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      { archived: true, alreadyArchived: false, id: updated.id, code: updated.code, status: updated.status },
      requestId,
    );
  });
}
