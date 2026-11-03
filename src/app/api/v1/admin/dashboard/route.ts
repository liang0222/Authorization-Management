import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse } from "@/lib/http/api";

const EFFECTIVE_STATUS_CASE = `
  CASE
    WHEN p.status <> 'active' THEN 'product_disabled'
    WHEN l.admin_status = 'revoked' THEN 'revoked'
    WHEN l.admin_status = 'cancelled' THEN 'cancelled'
    WHEN l.admin_status = 'suspended' THEN 'suspended'
    WHEN l.admin_status = 'draft' THEN 'draft'
    WHEN ((l.activation_count = 0 AND l.starts_at IS NULL)
          AND l.activation_deadline_at IS NOT NULL
          AND l.activation_deadline_at < now()) THEN 'activation_window_expired'
    WHEN l.starts_at IS NOT NULL AND l.starts_at > now() THEN 'not_yet_valid'
    WHEN l.expires_at IS NOT NULL AND l.expires_at <= now() THEN 'expired'
    ELSE 'active'
  END
`;

/** 工作台数据总览：全部指标来自真实查询，不做前端假数据。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "dashboard:read", async ({ session, requestId }) => {
    const organizationId = session.organization.id;
    // 图表按组织时区切日，而不是按服务器 UTC 切日，否则「今天」会错开 8 小时。
    const timeZone = session.organization.timezone || "UTC";

    const [
      statusRows,
      licenseTotals,
      activeDevices,
      recentActivations,
      expiringSoon,
      verification24h,
      auditCount7d,
    ] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ status: string; total: bigint }>>(
        `SELECT (${EFFECTIVE_STATUS_CASE}) AS status, count(*)::bigint AS total
         FROM licenses l JOIN products p ON p.id = l.product_id
         WHERE l.organization_id = $1::uuid AND l.deleted_at IS NULL
         GROUP BY 1 ORDER BY 2 DESC`,
        organizationId,
      ),
      prisma.licenses.count({ where: { organization_id: organizationId, deleted_at: null } }),
      prisma.activations.count({ where: { organization_id: organizationId, status: "active" } }),
      prisma.activation_events.count({
        where: {
          organization_id: organizationId,
          event_type: "activation.created",
          created_at: { gte: new Date(Date.now() - 7 * 86_400_000) },
        },
      }),
      prisma.licenses.count({
        where: {
          organization_id: organizationId,
          deleted_at: null,
          admin_status: { in: ["pending", "active"] },
          expires_at: { gt: new Date(), lt: new Date(Date.now() + 30 * 86_400_000) },
        },
      }),
      prisma.$queryRawUnsafe<Array<{ total: bigint; failed: bigint; avg_latency: number | null }>>(
        `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE response_status >= 400)::bigint AS failed,
                avg(latency_ms)::float AS avg_latency
         FROM api_request_logs
         WHERE organization_id = $1::uuid AND created_at >= now() - interval '24 hours'`,
        organizationId,
      ),
      prisma.audit_logs.count({
        where: { organization_id: organizationId, created_at: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      }),
    ]);

    const [activationSeries, verificationSeries, topProducts, nextToExpire, recentAudit] =
      await Promise.all([
        prisma.$queryRawUnsafe<Array<{ day: string; total: bigint }>>(
          `WITH buckets AS (
             SELECT (date_trunc('day', now() AT TIME ZONE $2) - (n || ' days')::interval) AS day
             FROM generate_series(0, 13) AS n
           )
           SELECT to_char(b.day, 'YYYY-MM-DD') AS day, count(e.id)::bigint AS total
           FROM buckets b
           LEFT JOIN activation_events e
             ON e.organization_id = $1::uuid AND e.event_type = 'activation.created'
            AND date_trunc('day', e.created_at AT TIME ZONE $2) = b.day
           GROUP BY b.day ORDER BY b.day`,
          organizationId,
          timeZone,
        ),
        prisma.$queryRawUnsafe<Array<{ day: string; total: bigint; failed: bigint }>>(
          `WITH buckets AS (
             SELECT (date_trunc('day', now() AT TIME ZONE $2) - (n || ' days')::interval) AS day
             FROM generate_series(0, 13) AS n
           )
           SELECT to_char(b.day, 'YYYY-MM-DD') AS day,
                  count(l.id)::bigint AS total,
                  count(l.id) FILTER (WHERE l.response_status >= 400)::bigint AS failed
           FROM buckets b
           LEFT JOIN api_request_logs l
             ON l.organization_id = $1::uuid
            AND date_trunc('day', l.created_at AT TIME ZONE $2) = b.day
           GROUP BY b.day ORDER BY b.day`,
          organizationId,
          timeZone,
        ),
        prisma.$queryRawUnsafe<
          Array<{ id: string; name: string; code: string; product_type: string; licenses: bigint; devices: bigint }>
        >(
          `SELECT p.id, p.name, p.code, p.product_type::text AS product_type,
                  count(DISTINCT l.id)::bigint AS licenses,
                  count(DISTINCT a.id)::bigint AS devices
           FROM products p
           LEFT JOIN licenses l ON l.product_id = p.id AND l.deleted_at IS NULL
             AND l.admin_status IN ('pending','active')
           LEFT JOIN activations a ON a.product_id = p.id AND a.status = 'active'
           WHERE p.organization_id = $1::uuid
           GROUP BY p.id ORDER BY licenses DESC LIMIT 5`,
          organizationId,
        ),
        prisma.licenses.findMany({
          where: {
            organization_id: organizationId,
            deleted_at: null,
            admin_status: { in: ["pending", "active"] },
            expires_at: { gt: new Date() },
          },
          orderBy: { expires_at: "asc" },
          take: 8,
          include: {
            products: { select: { name: true } },
            customers: { select: { name: true } },
          },
        }),
        prisma.audit_logs.findMany({
          where: { organization_id: organizationId },
          orderBy: { created_at: "desc" },
          take: 8,
        }),
      ]);

    const statusMap: Record<string, number> = {};
    for (const row of statusRows) statusMap[row.status] = Number(row.total);

    const actorIds = Array.from(new Set(recentAudit.map((row) => row.actor_id).filter((id): id is string => Boolean(id))));
    const actors = actorIds.length
      ? await prisma.users.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, display_name: true },
        })
      : [];
    const actorMap = new Map(actors.map((actor) => [actor.id, actor.display_name]));

    const verificationTotal = Number(verification24h[0]?.total ?? 0);
    const verificationFailed = Number(verification24h[0]?.failed ?? 0);

    return okResponse(
      {
        generatedAt: new Date().toISOString(),
        kpis: {
          licensesTotal: licenseTotals,
          licensesActive: statusMap.active ?? 0,
          expiringIn30Days: expiringSoon,
          suspended: statusMap.suspended ?? 0,
          revoked: statusMap.revoked ?? 0,
          activeDevices,
          activationsLast7Days: recentActivations,
          verification24h: {
            total: verificationTotal,
            failed: verificationFailed,
            successRate: verificationTotal === 0 ? null : 1 - verificationFailed / verificationTotal,
            avgLatencyMs: Math.round(Number(verification24h[0]?.avg_latency ?? 0)),
          },
          auditEvents7Days: auditCount7d,
        },
        statusDistribution: Object.entries(statusMap).map(([status, total]) => ({ status, total })),
        activationSeries: activationSeries.map((row) => ({
          date: row.day,
          total: Number(row.total),
        })),
        verificationSeries: verificationSeries.map((row) => ({
          date: row.day,
          total: Number(row.total),
          failed: Number(row.failed),
        })),
        topProducts: topProducts.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          type: row.product_type,
          licenses: Number(row.licenses),
          devices: Number(row.devices),
        })),
        expiringSoon: nextToExpire.map((row) => ({
          id: row.id,
          productName: row.products.name,
          customerName: row.customers.name,
          expiresAt: row.expires_at?.toISOString() ?? null,
          adminStatus: row.admin_status,
        })),
        recentAudit: recentAudit.map((row) => ({
          id: row.id.toString(),
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          actorName: row.actor_id ? actorMap.get(row.actor_id) ?? "系统" : "系统",
          createdAt: row.created_at.toISOString(),
        })),
      },
      requestId,
    );
  });
}
