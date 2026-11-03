import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const durationSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("day"), value: z.number().int().min(1).max(3650) }),
  z.object({ unit: z.literal("month"), value: z.number().int().min(1).max(120) }),
  z.object({ unit: z.literal("lifetime"), value: z.literal(0) }),
]);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).nullish(),
  status: z.enum(["active", "disabled", "archived"]).optional(),
  duration: durationSchema.optional(),
  startPolicy: z.enum(["on_first_activation", "fixed_start"]).optional(),
  activationDeadlineDays: z.number().int().min(0).max(3650).nullish(),
  maxDevices: z.number().int().min(1).max(1000).optional(),
  maxActivationCount: z.number().int().min(1).max(100000).nullish(),
  maxSubjects: z.number().int().min(1).max(1000).nullish(),
  refundActivationOnRelease: z.boolean().optional(),
  offlineAllowed: z.boolean().optional(),
  offlineGraceSeconds: z.number().int().min(0).max(31_536_000).optional(),
  features: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "plan:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const plan = await prisma.plans.findFirst({
      where: { id, organization_id: session.organization.id },
      include: {
        products: { select: { id: true, name: true, code: true } },
        plan_features: { orderBy: { feature_code: "asc" } },
      },
    });
    if (!plan) throw new ApiError(404, "RESOURCE_NOT_FOUND", "套餐不存在或不属于当前组织");

    const [features, issued] = await Promise.all([
      prisma.product_features.findMany({
        where: { product_id: plan.product_id, status: "active" },
        orderBy: { code: "asc" },
        select: { code: true, name: true, value_type: true, default_value: true },
      }),
      prisma.licenses.count({
        where: { plan_id: id, organization_id: session.organization.id, deleted_at: null },
      }),
    ]);

    return okResponse(
      {
        plan: {
          id: plan.id,
          code: plan.code,
          name: plan.name,
          description: plan.description,
          status: plan.status,
          duration: { unit: plan.duration_unit, value: plan.duration_value },
          startPolicy: plan.start_policy,
          activationDeadlineDays: plan.activation_deadline_days,
          maxDevices: plan.max_devices,
          maxActivationCount: plan.max_activation_count,
          maxSubjects: plan.max_subjects,
          refundActivationOnRelease: plan.refund_activation_on_release,
          offlineAllowed: plan.offline_allowed,
          offlineGraceSeconds: plan.offline_grace_seconds,
          defaultFeatures: plan.default_features,
          product: plan.products,
          createdAt: plan.created_at.toISOString(),
        },
        features,
        overrides: plan.plan_features.map((row) => ({
          code: row.feature_code,
          value: row.feature_value,
        })),
        issuedCount: issued,
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "plan:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);
    const before = await prisma.plans.findFirst({
      where: { id, organization_id: session.organization.id },
    });
    if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "套餐不存在");

    try {
      await prisma.$transaction(async (tx) => {
        await tx.plans.update({
          where: { id },
          data: {
            name: body.name,
            description: body.description === undefined ? undefined : body.description,
            status: body.status,
            duration_unit: body.duration?.unit,
            duration_value: body.duration?.value,
            start_policy: body.startPolicy,
            activation_deadline_days:
              body.activationDeadlineDays === undefined ? undefined : body.activationDeadlineDays,
            max_devices: body.maxDevices,
            max_activation_count:
              body.maxActivationCount === undefined ? undefined : body.maxActivationCount,
            max_subjects: body.maxSubjects === undefined ? undefined : body.maxSubjects,
            refund_activation_on_release: body.refundActivationOnRelease,
            offline_allowed: body.offlineAllowed,
            offline_grace_seconds: body.offlineGraceSeconds,
            default_features: body.features === undefined ? undefined : (body.features as never),
            updated_at: new Date(),
          },
        });
        if (body.features !== undefined) {
          const codes = Object.keys(body.features);
          if (codes.length > 0) {
            const known = await tx.product_features.findMany({
              where: { product_id: before.product_id, code: { in: codes }, status: "active" },
              select: { code: true },
            });
            const knownSet = new Set(known.map((row) => row.code));
            const unknown = codes.filter((code) => !knownSet.has(code));
            if (unknown.length > 0) {
              throw new ApiError(400, "INVALID_REQUEST", `套餐包含未定义的功能编码：${unknown.join(", ")}`);
            }
          }
          await tx.plan_features.deleteMany({ where: { plan_id: id } });
          if (codes.length > 0) {
            await tx.plan_features.createMany({
              data: codes.map((code) => ({
                plan_id: id,
                product_id: before.product_id,
                organization_id: session.organization.id,
                feature_code: code,
                feature_value: body.features![code] as never,
              })),
            });
          }
        }
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "plan.update",
        resourceType: "plan",
        resourceId: id,
        before: { name: before.name, duration: [before.duration_unit, before.duration_value] },
        after: { name: body.name ?? before.name, featuresChanged: body.features !== undefined },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ updated: true }, requestId);
    } catch (error) {
      translatePrismaError(error, "套餐更新失败");
    }
  });
}
