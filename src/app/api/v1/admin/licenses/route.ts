import type { NextRequest } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { queryLicenses } from "@/lib/services/license-list";
import { issueLicense, type ActorContext } from "@/lib/services/licenses";

const durationSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("day"), value: z.number().int().min(1).max(3650) }),
  z.object({ unit: z.literal("month"), value: z.number().int().min(1).max(120) }),
  z.object({ unit: z.literal("lifetime"), value: z.literal(0) }),
]);

const issueSchema = z.object({
  productId: z.string().uuid("请选择产品"),
  customerId: z.string().uuid("请选择客户"),
  planId: z.string().uuid().nullish(),
  duration: durationSchema,
  startPolicy: z.enum(["on_first_activation", "fixed_start"]),
  startsAt: z.string().datetime().nullish(),
  activationDeadlineAt: z.string().datetime().nullish(),
  maxDevices: z.number().int().min(1).max(1000),
  maxActivationCount: z.number().int().min(1).max(100000).nullish(),
  maxSubjects: z.number().int().min(1).max(1000).nullish(),
  refundActivationOnRelease: z.boolean().optional(),
  offlineAllowed: z.boolean().optional(),
  offlineGraceSeconds: z.number().int().min(0).max(31_536_000).optional(),
  features: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
  notes: z.string().max(2000).nullish(),
  externalOrderId: z.string().max(120).nullish(),
  publish: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "license:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const adminStatus = url.searchParams.getAll("adminStatus");
    const result = await queryLicenses(session.organization.id, {
      page: query.page,
      pageSize: query.pageSize,
      offset: query.skip,
      q: query.q,
      sort: query.sort,
      order: query.order,
      productId: url.searchParams.get("productId") ?? undefined,
      customerId: url.searchParams.get("customerId") ?? undefined,
      adminStatus: adminStatus.length > 0 ? adminStatus : undefined,
      effectiveStatus: url.searchParams.get("effectiveStatus") ?? undefined,
      expiringInDays: Number(url.searchParams.get("expiringInDays") ?? 0) || undefined,
      createdFrom: url.searchParams.get("createdFrom") ?? undefined,
      createdTo: url.searchParams.get("createdTo") ?? undefined,
    });
    return okResponse(
      {
        ...result,
        ...cursorFields(result.items.length, result.total, query),
        serverTime: new Date().toISOString(),
      },
      requestId,
    );
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "license:issue", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, issueSchema);
    const actor: ActorContext = {
      organizationId: session.organization.id,
      actorId: session.user.id,
      requestId,
      ip,
      userAgent,
    };
    const issued = await issueLicense(actor, {
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
      refundActivationOnRelease: body.refundActivationOnRelease,
      offlineAllowed: body.offlineAllowed,
      offlineGraceSeconds: body.offlineGraceSeconds,
      features: body.features,
      notes: body.notes ?? null,
      externalOrderId: body.externalOrderId ?? null,
      publish: body.publish,
    });
    return okResponse(
      {
        ...issued,
        startsAt: issued.startsAt?.toISOString() ?? null,
        expiresAt: issued.expiresAt?.toISOString() ?? null,
        // 明文兑换码只在本次响应出现一次
        keyNotice: "兑换码仅显示一次，请立即交付客户；服务端只保存哈希",
      },
      requestId,
      { status: 201 },
    );
  });
}
