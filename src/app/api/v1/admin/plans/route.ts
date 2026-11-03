import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const durationSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("day"), value: z.number().int().min(1).max(3650) }),
  z.object({ unit: z.literal("month"), value: z.number().int().min(1).max(120) }),
  z.object({ unit: z.literal("lifetime"), value: z.literal(0) }),
]);

const planSchema = z.object({
  productId: z.string().uuid("请选择产品"),
  code: z
    .string()
    .trim()
    .min(2, "套餐编码至少 2 个字符")
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "编码只能包含小写字母、数字、- 和 _"),
  name: z.string().trim().min(1, "请填写套餐名称").max(160),
  description: z.string().max(2000).nullish(),
  duration: durationSchema,
  startPolicy: z.enum(["on_first_activation", "fixed_start"]),
  activationDeadlineDays: z.number().int().min(0).max(3650).nullish(),
  maxDevices: z.number().int().min(1).max(1000),
  maxActivationCount: z.number().int().min(1).max(100000).nullish(),
  maxSubjects: z.number().int().min(1).max(1000).nullish(),
  refundActivationOnRelease: z.boolean().optional(),
  offlineAllowed: z.boolean().optional(),
  offlineGraceSeconds: z.number().int().min(0).max(31_536_000).optional(),
  features: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "plan:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const productId = url.searchParams.get("productId");
    const status = url.searchParams.get("status");
    const where = {
      organization_id: session.organization.id,
      ...(productId ? { product_id: productId } : {}),
      ...(status && ["active", "disabled", "archived"].includes(status)
        ? { status: status as "active" | "disabled" | "archived" }
        : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { code: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.plans.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        include: {
          products: { select: { id: true, name: true, code: true } },
          _count: { select: { licenses: true, plan_features: true } },
        },
      }),
      prisma.plans.count({ where }),
    ]);

    // 已签发授权数量（不含软删除）
    const issued = await prisma.licenses.groupBy({
      by: ["plan_id"],
      where: {
        organization_id: session.organization.id,
        plan_id: { in: rows.map((row) => row.id) },
        deleted_at: null,
      },
      _count: { _all: true },
    });
    const issuedMap = new Map(issued.map((row) => [row.plan_id, row._count._all]));

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          status: row.status,
          duration: { unit: row.duration_unit, value: row.duration_value },
          startPolicy: row.start_policy,
          activationDeadlineDays: row.activation_deadline_days,
          maxDevices: row.max_devices,
          maxActivationCount: row.max_activation_count,
          maxSubjects: row.max_subjects,
          refundActivationOnRelease: row.refund_activation_on_release,
          offlineAllowed: row.offline_allowed,
          offlineGraceSeconds: row.offline_grace_seconds,
          defaultFeatures: row.default_features,
          product: row.products,
          createdAt: row.created_at.toISOString(),
          counts: { features: row._count.plan_features, issued: issuedMap.get(row.id) ?? 0 },
        })),
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

export async function POST(req: NextRequest) {
  return withAdmin(req, "plan:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, planSchema);
    const product = await prisma.products.findFirst({
      where: { id: body.productId, organization_id: session.organization.id },
      select: { id: true, name: true },
    });
    if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");

    if (body.features && Object.keys(body.features).length > 0) {
      const codes = Object.keys(body.features);
      const existing = await prisma.product_features.findMany({
        where: { product_id: body.productId, code: { in: codes }, status: "active" },
        select: { code: true },
      });
      const known = new Set(existing.map((row) => row.code));
      const unknown = codes.filter((code) => !known.has(code));
      if (unknown.length > 0) {
        throw new ApiError(400, "INVALID_REQUEST", `套餐包含未定义的功能编码：${unknown.join(", ")}`);
      }
    }

    try {
      const plan = await prisma.$transaction(async (tx) => {
        const created = await tx.plans.create({
          data: {
            organization_id: session.organization.id,
            product_id: body.productId,
            code: body.code,
            name: body.name,
            description: body.description ?? null,
            duration_unit: body.duration.unit,
            duration_value: body.duration.value,
            start_policy: body.startPolicy,
            activation_deadline_days: body.activationDeadlineDays ?? null,
            max_devices: body.maxDevices,
            max_activation_count: body.maxActivationCount ?? null,
            max_subjects: body.maxSubjects ?? null,
            refund_activation_on_release: body.refundActivationOnRelease ?? false,
            offline_allowed: body.offlineAllowed ?? false,
            offline_grace_seconds: body.offlineGraceSeconds ?? 0,
            default_features: (body.features ?? {}) as never,
          },
        });
        if (body.features && Object.keys(body.features).length > 0) {
          await tx.plan_features.createMany({
            data: Object.entries(body.features).map(([code, value]) => ({
              plan_id: created.id,
              product_id: body.productId,
              organization_id: session.organization.id,
              feature_code: code,
              feature_value: value as never,
            })),
          });
        }
        return created;
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "plan.create",
        resourceType: "plan",
        resourceId: plan.id,
        after: {
          product: product.name,
          code: plan.code,
          duration: body.duration,
          max_devices: plan.max_devices,
        },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ id: plan.id }, requestId, { status: 201 });
    } catch (error) {
      translatePrismaError(error, "该产品下已存在相同套餐编码");
    }
  });
}
