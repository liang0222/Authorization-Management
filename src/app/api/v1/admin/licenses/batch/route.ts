import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse, readJson } from "@/lib/http/api";
import { issueLicense, type ActorContext } from "@/lib/services/licenses";

const durationSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("day"), value: z.number().int().min(1).max(3650) }),
  z.object({ unit: z.literal("month"), value: z.number().int().min(1).max(120) }),
  z.object({ unit: z.literal("lifetime"), value: z.literal(0) }),
]);

const batchSchema = z.object({
  count: z.number().int().min(1, "至少 1 张").max(50, "单次最多 50 张"),
  productId: z.string().uuid(),
  customerId: z.string().uuid(),
  planId: z.string().uuid().nullish(),
  duration: durationSchema,
  startPolicy: z.enum(["on_first_activation", "fixed_start"]),
  startsAt: z.string().datetime().nullish(),
  activationDeadlineAt: z.string().datetime().nullish(),
  maxDevices: z.number().int().min(1).max(1000),
  maxActivationCount: z.number().int().min(1).max(100000).nullish(),
  maxSubjects: z.number().int().min(1).max(1000).nullish(),
  offlineAllowed: z.boolean().optional(),
  offlineGraceSeconds: z.number().int().min(0).max(31_536_000).optional(),
  notes: z.string().max(2000).nullish(),
  externalOrderId: z.string().max(120).nullish(),
});

/**
 * 批量发码（规格 7.4）。
 * 第一阶段的实现边界：单次 ≤ 50 张、同步返回、明文只出现一次；
 * 更大批量需要走异步任务队列，已在 docs/DELIVERY.md 标注为后续项。
 */
export async function POST(req: NextRequest) {
  return withAdmin(req, "license:issue", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, batchSchema);
    const actor: ActorContext = {
      organizationId: session.organization.id,
      actorId: session.user.id,
      requestId,
      ip,
      userAgent,
    };

    const issued: Array<{ id: string; licenseKey: string; expiresAt: string | null }> = [];
    for (let index = 0; index < body.count; index += 1) {
      const result = await issueLicense(actor, {
        productId: body.productId,
        customerId: body.customerId,
        planId: body.planId ?? null,
        duration: body.duration,
        startPolicy: body.startPolicy,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        activationDeadlineAt: body.activationDeadlineAt ? new Date(body.activationDeadlineAt) : null,
        maxDevices: body.maxDevices,
        maxActivationCount: body.maxActivationCount ?? null,
        maxSubjects: body.maxSubjects ?? null,
        offlineAllowed: body.offlineAllowed,
        offlineGraceSeconds: body.offlineGraceSeconds,
        notes: body.notes ?? null,
        externalOrderId: body.externalOrderId ?? null,
        publish: true,
      });
      issued.push({
        id: result.id,
        licenseKey: result.licenseKey,
        expiresAt: result.expiresAt?.toISOString() ?? null,
      });
    }

    // 批量结果只在本次响应返回，CSV 由前端内存生成，不落库
    return okResponse(
      {
        count: issued.length,
        items: issued,
        notice: "批量兑换码仅在本次响应中返回，请立即下载或复制；刷新后无法再次获取明文",
      },
      requestId,
      { status: 201 },
    );
  });
}

/** 批量生成页需要的下拉数据：产品/客户/套餐。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "license:read", async ({ session, requestId }) => {
    const [products, customers, plans] = await Promise.all([
      prisma.products.findMany({
        where: { organization_id: session.organization.id, status: "active" },
        select: { id: true, name: true, code: true },
        orderBy: { name: "asc" },
      }),
      prisma.customers.findMany({
        where: { organization_id: session.organization.id, status: "active" },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      }),
      prisma.plans.findMany({
        where: { organization_id: session.organization.id, status: "active" },
        select: {
          id: true,
          name: true,
          code: true,
          product_id: true,
          duration_unit: true,
          duration_value: true,
          max_devices: true,
          max_activation_count: true,
          max_subjects: true,
          start_policy: true,
        },
        orderBy: { name: "asc" },
      }),
    ]);
    return okResponse({ products, customers, plans }, requestId);
  });
}
