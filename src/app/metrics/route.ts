import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

/**
 * GET /metrics —— Prometheus 文本格式（规格 18.2）。
 *
 * 只接受 `Authorization: Bearer $METRICS_TOKEN`。
 *
 * 为什么不做“本机直连就放行”：经过 openresty 反代后，Node 看到的源地址永远是
 * 127.0.0.1，靠地址判断等于对公网全开。X-Forwarded-For 也可被客户端伪造，
 * 所以这里只认预共享令牌 —— 宁可监控采不到，也不把容量与错误分布暴露出去。
 * 反向代理层还有一道 `location = /metrics { deny all; }`，双保险。
 */
function authorized(request: Request): boolean {
  const token = process.env.METRICS_TOKEN;
  // 没配令牌就一律拒绝：宁可监控采不到，也不要把它变成公开的容量情报源。
  // 本机调试时把 METRICS_TOKEN 写进 env 再带 Authorization 头取。
  if (!token) return false;
  return (request.headers.get("authorization") ?? "") === `Bearer ${token}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new Response("metrics endpoint is internal-only\n", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const [statusRows, counts, webhookRows, backupRows] = await Promise.all([
    prisma.$queryRaw<{ total: bigint; success: bigint; p95: number | null; p50: number | null }[]>`
      WITH windowed AS (
        SELECT response_status, latency_ms
        FROM api_request_logs
        WHERE created_at >= now() - interval '24 hours'
      )
      SELECT count(*)::bigint AS total,
             count(*) FILTER (WHERE response_status < 400)::bigint AS success,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95,
             percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms)::int AS p50
      FROM windowed
    `,
    prisma.$queryRaw<{ licenses: bigint; active_activations: bigint; devices: bigint }[]>`
      SELECT (SELECT count(*) FROM licenses WHERE deleted_at IS NULL)::bigint AS licenses,
             (SELECT count(*) FROM activations WHERE status = 'active')::bigint AS active_activations,
             (SELECT count(*) FROM devices)::bigint AS devices
    `,
    prisma.$queryRaw<{ status: string; n: bigint }[]>`
      SELECT status::text AS status, count(*)::bigint AS n FROM webhook_deliveries GROUP BY 1
    `,
    prisma.$queryRaw<{ status: string; n: bigint }[]>`
      SELECT status::text AS status, count(*)::bigint AS n FROM backup_jobs GROUP BY 1
    `,
  ]);

  const row = statusRows[0];
  const total = Number(row?.total ?? 0);
  const success = Number(row?.success ?? 0);
  const c = counts[0];

  const lines: string[] = [];
  const metric = (name: string, help: string, type: string, value: number, labels = "") => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labels} ${value}`);
  };

  metric("licensing_api_requests_24h", "API requests in the last 24 hours", "gauge", total);
  metric("licensing_api_success_24h", "Successful API requests in the last 24 hours", "gauge", success);
  metric(
    "licensing_api_success_ratio_24h",
    "Success ratio in the last 24 hours",
    "gauge",
    total === 0 ? 0 : Number((success / total).toFixed(4)),
  );
  metric("licensing_api_latency_p50_ms", "API p50 latency", "gauge", Number(row?.p50 ?? 0));
  metric("licensing_api_latency_p95_ms", "API p95 latency", "gauge", Number(row?.p95 ?? 0));
  metric("licensing_licenses_total", "Non-deleted licenses", "gauge", Number(c?.licenses ?? 0));
  metric("licensing_activations_active", "Active activations", "gauge", Number(c?.active_activations ?? 0));
  metric("licensing_devices_total", "Registered devices", "gauge", Number(c?.devices ?? 0));

  lines.push("# HELP licensing_webhook_deliveries Webhook deliveries by status");
  lines.push("# TYPE licensing_webhook_deliveries gauge");
  for (const item of webhookRows) {
    lines.push(`licensing_webhook_deliveries{status="${item.status}"} ${Number(item.n)}`);
  }

  lines.push("# HELP licensing_backup_jobs Backup jobs by status");
  lines.push("# TYPE licensing_backup_jobs gauge");
  for (const item of backupRows) {
    lines.push(`licensing_backup_jobs{status="${item.status}"} ${Number(item.n)}`);
  }

  lines.push(`# HELP licensing_info Build information`);
  lines.push(`# TYPE licensing_info gauge`);
  lines.push(`licensing_info{env="${config.deploymentEnv}"} 1`);

  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}
