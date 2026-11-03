import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, pageResult, readListQuery } from "@/lib/http/api";

/**
 * 单个 Webhook 端点的投递记录（规格第 8 节：失败按指数退避重试，多次失败进入 dead 等待重放）。
 * 只返回排障需要的字段，payload 体积可能很大，列表里不带。
 */

const DELIVERY_STATUSES = ["pending", "delivering", "succeeded", "failed", "dead"] as const;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "webhook:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const endpoint = await prisma.webhook_endpoints.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, url: true, status: true },
    });
    if (!endpoint) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Webhook 端点不存在");

    const url = new URL(req.url);
    const query = readListQuery(url);
    const status = url.searchParams.get("status");
    const where = {
      endpoint_id: id,
      ...(status && (DELIVERY_STATUSES as readonly string[]).includes(status)
        ? { status: status as (typeof DELIVERY_STATUSES)[number] }
        : {}),
      ...(query.q
        ? {
            OR: [
              { event_id: { contains: query.q, mode: "insensitive" as const } },
              { event_type: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.webhook_deliveries.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        select: {
          id: true,
          event_id: true,
          event_type: true,
          status: true,
          attempt_count: true,
          next_attempt_at: true,
          response_status: true,
          last_error: true,
          created_at: true,
          delivered_at: true,
        },
      }),
      prisma.webhook_deliveries.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      status: row.status,
      attemptCount: row.attempt_count,
      responseStatus: row.response_status,
      lastError: row.last_error,
      nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      deliveredAt: row.delivered_at?.toISOString() ?? null,
    }));

    return okResponse(
      {
        ...pageResult(items, total, query),
        endpoint: { id: endpoint.id, url: endpoint.url, status: endpoint.status },
      },
      requestId,
    );
  });
}
