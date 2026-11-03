import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enforceRateLimit, PUBLIC_RATE_LIMITS } from "@/lib/services/rate-limit-store";

/**
 * GET /api/v1/status —— 公开健康状态（规格 27.2 的 /developers/status 数据源）。
 *
 * 只暴露聚合数字：请求总量、成功率、P95 延迟。不暴露任何租户、产品、IP 或错误明细，
 * 因此不需要认证。仍然限流，否则这个端点会变成免费的压测入口。
 */
interface StatusRow {
  total: bigint;
  success: bigint;
  p95: number | null;
}

export async function GET(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  let limit = { limit: PUBLIC_RATE_LIMITS.default.limit, remaining: 0, resetSeconds: 60 };
  try {
    const result = await enforceRateLimit({
      rule: PUBLIC_RATE_LIMITS.default,
      organizationId: null,
      productId: null,
      ip,
    });
    limit = { limit: result.limit, remaining: result.remaining, resetSeconds: result.resetSeconds };
  } catch {
    return NextResponse.json(
      { ok: false, code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试", data: null },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const rows = await prisma.$queryRaw<StatusRow[]>`
    WITH windowed AS (
      SELECT response_status, latency_ms
      FROM api_request_logs
      WHERE created_at >= now() - interval '24 hours'
    )
    SELECT
      count(*)::bigint AS total,
      count(*) FILTER (WHERE response_status < 400)::bigint AS success,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95
    FROM windowed
  `;

  const row = rows[0];
  const total = Number(row?.total ?? 0);
  const success = Number(row?.success ?? 0);

  return NextResponse.json(
    {
      ok: true,
      code: "OK",
      message: "成功",
      request_id: `req_status_${Date.now().toString(36)}`,
      server_time: new Date().toISOString(),
      data: {
        window: "24h",
        total_requests: total,
        success_rate: total === 0 ? null : Number((success / total).toFixed(4)),
        p95_latency_ms: row?.p95 ?? null,
        components: [
          { name: "公共 API", status: "operational" },
          { name: "Webhook 投递", status: "operational" },
          { name: "开发者文档", status: "operational" },
        ],
      },
    },
    {
      headers: {
        "ratelimit-limit": String(limit.limit),
        "ratelimit-remaining": String(limit.remaining),
        "ratelimit-reset": String(limit.resetSeconds),
      },
    },
  );
}
