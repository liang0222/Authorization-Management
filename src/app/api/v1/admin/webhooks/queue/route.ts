import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";
import { dispatchDueWebhooks } from "@/lib/services/webhook-dispatcher";

/**
 * Webhook 投递队列健康度（规格 8 / 16.10 的「作业历史」思路）。
 *
 * 后台需要能回答三个问题：现在积压多少、最老的一条等了多久、失败的原因集中在哪。
 * 这些都不能靠猜——直接查 `webhook_deliveries` 的分布。
 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "webhook:read", async ({ session, requestId }) => {
    const organizationId = session.organization.id;

    const [byStatus, oldestPending, recentDead, recentSucceeded] = await Promise.all([
      prisma.webhook_deliveries.groupBy({
        by: ["status"],
        where: { webhook_endpoints: { organization_id: organizationId } },
        _count: { _all: true },
      }),
      prisma.webhook_deliveries.findFirst({
        where: {
          status: "pending",
          webhook_endpoints: { organization_id: organizationId },
        },
        orderBy: { created_at: "asc" },
        select: { id: true, event_type: true, created_at: true, attempt_count: true },
      }),
      prisma.webhook_deliveries.findMany({
        where: {
          status: "dead",
          webhook_endpoints: { organization_id: organizationId },
        },
        orderBy: { created_at: "desc" },
        take: 5,
        select: {
          id: true,
          event_type: true,
          last_error: true,
          response_status: true,
          created_at: true,
          webhook_endpoints: { select: { url: true } },
        },
      }),
      prisma.webhook_deliveries.findMany({
        where: {
          status: "succeeded",
          webhook_endpoints: { organization_id: organizationId },
        },
        orderBy: { delivered_at: "desc" },
        take: 1,
        select: { delivered_at: true },
      }),
    ]);

    const counts = { pending: 0, delivering: 0, succeeded: 0, failed: 0, dead: 0 };
    for (const row of byStatus) counts[row.status] = row._count._all;

    return okResponse(
      {
        counts,
        oldestPending: oldestPending
          ? {
              id: oldestPending.id,
              eventType: oldestPending.event_type,
              createdAt: oldestPending.created_at.toISOString(),
              waitedSeconds: Math.round((Date.now() - oldestPending.created_at.getTime()) / 1000),
              attemptCount: oldestPending.attempt_count,
            }
          : null,
        lastSucceededAt: recentSucceeded[0]?.delivered_at?.toISOString() ?? null,
        recentDead: recentDead.map((row) => ({
          id: row.id,
          eventType: row.event_type,
          lastError: row.last_error,
          responseStatus: row.response_status,
          createdAt: row.created_at.toISOString(),
          url: row.webhook_endpoints.url,
        })),
      },
      requestId,
    );
  });
}

/** 手动触发一轮投递（运维排查用；正常由 instrumentation 的定时器驱动）。 */
export async function POST(req: NextRequest) {
  return withAdmin(req, "webhook:write", async ({ session, requestId, ip, userAgent }) => {
    const summary = await dispatchDueWebhooks(50);

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "webhook.dispatch",
      resourceType: "webhook_delivery",
      resourceId: null,
      after: summary,
      requestId,
      ip,
      userAgent,
    });

    return okResponse(summary, requestId);
  });
}
