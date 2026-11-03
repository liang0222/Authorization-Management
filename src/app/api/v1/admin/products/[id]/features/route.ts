import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const featureSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "功能编码至少 2 个字符")
    .max(100)
    .regex(/^[a-z0-9][a-z0-9_.]*$/, "功能编码只能包含小写字母、数字、下划线和点"),
  name: z.string().trim().min(1, "请填写功能名称").max(160),
  description: z.string().max(1000).nullish(),
  valueType: z.enum(["boolean", "number", "string", "json"]).default("boolean"),
  defaultValue: z.union([z.boolean(), z.number(), z.string()]).default(true),
});

/** 产品的功能权限定义（规格 2.3-B）。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "feature:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const product = await prisma.products.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true },
    });
    if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");
    const features = await prisma.product_features.findMany({
      where: { product_id: id, organization_id: session.organization.id },
      orderBy: { created_at: "asc" },
    });
    return okResponse(
      {
        items: features.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          valueType: row.value_type,
          defaultValue: row.default_value,
          status: row.status,
          createdAt: row.created_at.toISOString(),
        })),
      },
      requestId,
    );
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "feature:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const product = await prisma.products.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, name: true },
    });
    if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");
    const body = await readJson(req, featureSchema);
    try {
      const feature = await prisma.product_features.create({
        data: {
          organization_id: session.organization.id,
          product_id: id,
          code: body.code,
          name: body.name,
          description: body.description ?? null,
          value_type: body.valueType,
          default_value: body.defaultValue as never,
        },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "feature.create",
        resourceType: "product_feature",
        resourceId: feature.id,
        after: { product: product.name, code: feature.code, default: feature.default_value },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ id: feature.id }, requestId, { status: 201 });
    } catch (error) {
      translatePrismaError(error, "该产品下已存在同名功能编码");
    }
  });
}
