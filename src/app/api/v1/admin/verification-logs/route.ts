import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, pageResult, readListQuery } from "@/lib/http/api";

/**
 * 验证日志（规格 9：对外客户端授权校验请求的可观测性）。
 *
 * 数据源是 api_request_logs；该表按天增长很快，所以：
 * - 一律服务端分页，pageSize 由 readListQuery 限制在 100 以内。
 * - 过滤条件全部走 $n 参数占位符（$queryRawUnsafe 只是复用其它列表接口的写法，参数仍然绑定）。
 * - summary 用同一条 WHERE 条件的聚合查询得出，保证与 items 口径一致。
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface FilterSet {
  clause: string;
  args: unknown[];
}

function parseDateParam(value: string | null, field: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} 必须是合法的 ISO 时间`);
  }
  return date;
}

function buildFilters(organizationId: string, search: URLSearchParams): FilterSet {
  const args: unknown[] = [organizationId];
  const conditions: string[] = ["l.organization_id = $1::uuid"];

  const statusRaw = search.get("status");
  if (statusRaw) {
    const status = Number(statusRaw);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new ApiError(400, "INVALID_REQUEST", "status 必须是 100-599 之间的 HTTP 状态码");
    }
    args.push(status);
    conditions.push(`l.response_status = $${args.length}`);
  }

  const productId = search.get("productId");
  if (productId) {
    if (!UUID_RE.test(productId)) {
      throw new ApiError(400, "INVALID_REQUEST", "productId 必须是合法的 UUID");
    }
    args.push(productId);
    conditions.push(`l.product_id = $${args.length}::uuid`);
  }

  const route = (search.get("route") ?? "").trim();
  if (route) {
    args.push(`%${route}%`);
    conditions.push(`l.route ILIKE $${args.length}`);
  }

  const q = (search.get("q") ?? "").trim();
  if (q) {
    args.push(q);
    const exactIndex = args.length;
    args.push(`%${q}%`);
    conditions.push(`(l.request_id = $${exactIndex} OR l.request_id ILIKE $${args.length})`);
  }

  const from = parseDateParam(search.get("from"), "from");
  if (from) {
    args.push(from);
    conditions.push(`l.created_at >= $${args.length}`);
  }
  const to = parseDateParam(search.get("to"), "to");
  if (to) {
    args.push(to);
    conditions.push(`l.created_at <= $${args.length}`);
  }

  return { clause: conditions.join(" AND "), args };
}

interface LogRow {
  id: string;
  request_id: string;
  method: string;
  route: string;
  response_status: number;
  error_code: string | null;
  latency_ms: number;
  ip: string | null;
  product_id: string | null;
  product_name: string | null;
  created_at: Date;
}

interface SummaryRow {
  total: bigint;
  succeeded: bigint;
  client_errors: bigint;
  server_errors: bigint;
  avg_latency: number | null;
}

export async function GET(req: NextRequest) {
  return withAdmin(req, "verification:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const { clause, args } = buildFilters(session.organization.id, url.searchParams);

    const limitIndex = args.length + 1;
    const offsetIndex = args.length + 2;

    const [rows, summaryRows] = await Promise.all([
      prisma.$queryRawUnsafe<LogRow[]>(
        `SELECT l.id::text AS id, l.request_id, l.method, l.route, l.response_status,
                l.error_code, l.latency_ms, host(l.ip) AS ip, l.product_id,
                p.name AS product_name, l.created_at
         FROM api_request_logs l
         LEFT JOIN products p ON p.id = l.product_id
         WHERE ${clause}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        ...args,
        query.pageSize,
        query.skip,
      ),
      prisma.$queryRawUnsafe<SummaryRow[]>(
        `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE l.response_status < 400)::bigint AS succeeded,
                count(*) FILTER (WHERE l.response_status >= 400 AND l.response_status < 500)::bigint AS client_errors,
                count(*) FILTER (WHERE l.response_status >= 500)::bigint AS server_errors,
                avg(l.latency_ms)::float AS avg_latency
         FROM api_request_logs l
         WHERE ${clause}`,
        ...args,
      ),
    ]);

    const summary = summaryRows[0];
    const total = Number(summary?.total ?? 0);
    const succeeded = Number(summary?.succeeded ?? 0);
    const clientErrors = Number(summary?.client_errors ?? 0);
    const serverErrors = Number(summary?.server_errors ?? 0);
    const avgLatency = summary?.avg_latency ?? null;

    const items = rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      method: row.method,
      route: row.route,
      status: row.response_status,
      errorCode: row.error_code,
      latencyMs: row.latency_ms,
      // PostgreSQL inet 通过 host() 转成不带掩码的文本，前端直接展示。
      ip: row.ip,
      productId: row.product_id,
      productName: row.product_name,
      createdAt: row.created_at.toISOString(),
    }));

    return okResponse(
      {
        ...pageResult(items, total, query),
        // 汇总口径与 items 的 where 完全一致：总数、成功率、4xx/5xx、平均延迟。
        summary: {
          totalRequests: total,
          successCount: succeeded,
          // 0-1 之间的小数，保留 4 位，避免前端再算一次除法口径不一致。
          successRate: total === 0 ? 0 : Math.round((succeeded / total) * 10_000) / 10_000,
          clientErrorCount: clientErrors,
          serverErrorCount: serverErrors,
          avgLatencyMs: avgLatency === null ? 0 : Math.round(Number(avgLatency)),
        },
      },
      requestId,
    );
  });
}
