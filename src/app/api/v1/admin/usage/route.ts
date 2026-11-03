import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { PUBLIC_RATE_LIMITS } from "@/lib/domain/public-rate-limits";
import { config } from "@/lib/config";

/**
 * 开发者用量分析（规格 27.12 用量面板 / P1-6）。
 *
 * 三块内容，数据源各不相同，刻意分开取，避免一个慢查询拖垮整页：
 * - 延迟与错误分布：`api_request_logs` 聚合（P50/P95/P99 用 percentile_cont）；
 * - 配额水位：`rate_limit_buckets` 的**当前窗口**计数（这就是「配额用了多少」的真实来源，
 *   不能拿历史请求数去估）；
 * - 限流命中：`api_request_logs` 里 `response_status = 429` 的按天计数。
 *
 * 为什么不用 Prisma 的 aggregate：`percentile_cont` 是 PostgreSQL 窗口聚合，
 * Prisma 查询构造器表达不了，只能走 $queryRaw。参数一律 $n 绑定。
 *
 * 口径约定：days 按组织时区切日（与仪表盘、验证日志一致），而不是 UTC。
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 配额水位分档。
 *
 * 为什么阈值放在服务端：前端若各写一份，同一份数据在不同页面会出现
 * 「这里橙色那里灰色」的不一致。文案也跟着档位走，前端只负责上色。
 */
const QUOTA_WARN_RATIO = 0.7;
const QUOTA_CRITICAL_RATIO = 0.9;

function parseDays(value: string | null): number {
  if (!value) return 14;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new ApiError(400, "INVALID_REQUEST", "days 必须是 1-90 之间的整数");
  }
  return days;
}

interface SqlFilters {
  clause: string;
  args: unknown[];
  /** productId 的参数位（形如 `$3`）；没传 productId 时为 null。 */
  productParam: string | null;
}

function buildFilters(organizationId: string, search: URLSearchParams, days: number): SqlFilters {
  const args: unknown[] = [organizationId];
  // 只统计公开 API（/api/v1/ 下的客户端端点）：管理后台自己的请求也在同一张表里，
  // 混进来会把 P95 拉得毫无意义（后台页面一次加载就是十几个请求）。
  const conditions: string[] = ["l.organization_id = $1::uuid"];

  args.push(days);
  conditions.push(`l.created_at >= now() - ($${args.length}::int || ' days')::interval`);

  let productParam: string | null = null;
  const productId = search.get("productId");
  if (productId) {
    if (!UUID_RE.test(productId)) {
      throw new ApiError(400, "INVALID_REQUEST", "productId 必须是合法的 UUID");
    }
    args.push(productId);
    productParam = `$${args.length}`;
    conditions.push(`l.product_id = ${productParam}::uuid`);
  }

  return { clause: conditions.join(" AND "), args, productParam };
}

interface DailyRow {
  day: string;
  total: bigint;
  succeeded: bigint;
  client_errors: bigint;
  server_errors: bigint;
  rate_limited: bigint;
  p50: number | null;
  p95: number | null;
  avg_latency: number | null;
}

interface LatencyRow {
  total: bigint;
  succeeded: bigint;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg_latency: number | null;
  max_latency: number | null;
}

interface ErrorRow {
  error_code: string | null;
  response_status: number;
  count: bigint;
  last_seen: Date;
}

interface RouteRow {
  route: string;
  method: string;
  count: bigint;
  client_errors: bigint;
  server_errors: bigint;
  p95: number | null;
}

interface ProductRow {
  product_id: string | null;
  product_code: string | null;
  product_name: string | null;
  count: bigint;
  client_errors: bigint;
  server_errors: bigint;
  p95: number | null;
}

interface BucketRow {
  bucket_key: string;
  count: number;
  window_start: Date;
  expires_at: Date;
}

export async function GET(req: NextRequest) {
  return withAdmin(req, "verification:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const days = parseDays(url.searchParams.get("days"));
    const { clause, args, productParam } = buildFilters(session.organization.id, url.searchParams, days);
    const timezone = session.organization.timezone ?? "UTC";

    const [latencyRows, dailyRows, errorRows, routeRows, productRows] = await Promise.all([
      prisma.$queryRawUnsafe<LatencyRow[]>(
        `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE l.response_status < 400)::bigint AS succeeded,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p95,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p99,
                avg(l.latency_ms)::float AS avg_latency,
                max(l.latency_ms)::int AS max_latency
         FROM api_request_logs l
         WHERE ${clause}`,
        ...args,
      ),
      // generate_series 补零：没有请求的那天也要出现在图上，否则折线会把两周画成两天。
      //
      // 这里刻意复用 $2（days）而不是传一个同值的新参数：PostgreSQL 要求每个 `$n`
      // 都能从上下文推断类型，**一个从不被引用的参数会直接报
      // 42P18 could not determine data type of parameter $n**。
      prisma.$queryRawUnsafe<DailyRow[]>(
        `WITH days AS (
           SELECT generate_series(
             (date_trunc('day', now() AT TIME ZONE $${args.length + 1}::text) - (($${args.length}::int - 1) || ' days')::interval),
             date_trunc('day', now() AT TIME ZONE $${args.length + 1}::text),
             '1 day'
           )::date AS day
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                count(l.id)::bigint AS total,
                count(l.id) FILTER (WHERE l.response_status < 400)::bigint AS succeeded,
                count(l.id) FILTER (WHERE l.response_status >= 400 AND l.response_status < 500
                                     AND l.response_status <> 429)::bigint AS client_errors,
                count(l.id) FILTER (WHERE l.response_status >= 500)::bigint AS server_errors,
                count(l.id) FILTER (WHERE l.response_status = 429)::bigint AS rate_limited,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p95,
                avg(l.latency_ms)::float AS avg_latency
         FROM days d
         LEFT JOIN api_request_logs l
           ON (l.created_at AT TIME ZONE $${args.length + 1}::text)::date = d.day
          AND l.organization_id = $1::uuid
          ${productParam ? `AND l.product_id = ${productParam}::uuid` : ""}
         GROUP BY d.day
         ORDER BY d.day`,
        ...args,
        timezone,
      ),
      prisma.$queryRawUnsafe<ErrorRow[]>(
        `SELECT COALESCE(l.error_code, 'HTTP_' || l.response_status) AS error_code,
                min(l.response_status) AS response_status,
                count(*)::bigint AS count,
                max(l.created_at) AS last_seen
         FROM api_request_logs l
         WHERE ${clause} AND l.response_status >= 400
         GROUP BY COALESCE(l.error_code, 'HTTP_' || l.response_status)
         ORDER BY count(*) DESC, 1
         LIMIT 12`,
        ...args,
      ),
      prisma.$queryRawUnsafe<RouteRow[]>(
        `SELECT l.route, l.method, count(*)::bigint AS count,
                count(*) FILTER (WHERE l.response_status >= 400 AND l.response_status < 500)::bigint AS client_errors,
                count(*) FILTER (WHERE l.response_status >= 500)::bigint AS server_errors,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p95
         FROM api_request_logs l
         WHERE ${clause}
         GROUP BY l.route, l.method
         ORDER BY count(*) DESC
         LIMIT 12`,
        ...args,
      ),
      prisma.$queryRawUnsafe<ProductRow[]>(
        `SELECT l.product_id, p.code AS product_code, p.name AS product_name,
                count(*)::bigint AS count,
                count(*) FILTER (WHERE l.response_status >= 400 AND l.response_status < 500)::bigint AS client_errors,
                count(*) FILTER (WHERE l.response_status >= 500)::bigint AS server_errors,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::float AS p95
         FROM api_request_logs l
         LEFT JOIN products p ON p.id = l.product_id
         WHERE ${clause}
         GROUP BY l.product_id, p.code, p.name
         ORDER BY count(*) DESC`,
        ...args,
      ),
    ]);

    const quota = await loadQuota(session.organization.id);

    const latency = latencyRows[0];
    const total = Number(latency?.total ?? 0);
    const succeeded = Number(latency?.succeeded ?? 0);
    const round = (value: number | null | undefined) =>
      value === null || value === undefined ? null : Math.round(Number(value));

    const daily = dailyRows.map((row) => {
      const dayTotal = Number(row.total);
      const daySucceeded = Number(row.succeeded);
      return {
        date: row.day,
        total: dayTotal,
        succeeded: daySucceeded,
        clientErrors: Number(row.client_errors),
        serverErrors: Number(row.server_errors),
        rateLimited: Number(row.rate_limited),
        successRate: dayTotal === 0 ? null : Math.round((daySucceeded / dayTotal) * 10_000) / 10_000,
        p50: round(row.p50),
        p95: round(row.p95),
        avgLatency: round(row.avg_latency),
      };
    });

    return okResponse(
      {
        range: { days, timezone },
        overview: {
          totalRequests: total,
          successCount: succeeded,
          // 0-1 的小数，保留 4 位；前端不再做除法，避免两个页面口径不同。
          successRate: total === 0 ? 0 : Math.round((succeeded / total) * 10_000) / 10_000,
          requestsPerDay: days === 0 ? 0 : Math.round(total / days),
          latency: {
            p50: round(latency?.p50),
            p95: round(latency?.p95),
            p99: round(latency?.p99),
            avg: round(latency?.avg_latency),
            max: round(latency?.max_latency),
          },
        },
        daily,
        errors: errorRows.map((row) => ({
          code: row.error_code ?? `HTTP_${row.response_status}`,
          status: row.response_status,
          count: Number(row.count),
          share: total === 0 ? 0 : Math.round((Number(row.count) / total) * 10_000) / 10_000,
          lastSeenAt: row.last_seen.toISOString(),
        })),
        routes: routeRows.map((row) => {
          const routeTotal = Number(row.count);
          const failures = Number(row.client_errors) + Number(row.server_errors);
          return {
            route: row.route,
            method: row.method,
            count: routeTotal,
            share: total === 0 ? 0 : Math.round((routeTotal / total) * 10_000) / 10_000,
            failureRate: routeTotal === 0 ? 0 : Math.round((failures / routeTotal) * 10_000) / 10_000,
            p95: round(row.p95),
          };
        }),
        products: productRows.map((row) => {
          const productTotal = Number(row.count);
          const failures = Number(row.client_errors) + Number(row.server_errors);
          return {
            productId: row.product_id,
            productCode: row.product_code,
            productName: row.product_name ?? "未知产品",
            count: productTotal,
            share: total === 0 ? 0 : Math.round((productTotal / total) * 10_000) / 10_000,
            failureRate: productTotal === 0 ? 0 : Math.round((failures / productTotal) * 10_000) / 10_000,
            p95: round(row.p95),
          };
        }),
        quota,
      },
      requestId,
    );
  });
}

/**
 * 当前窗口的配额水位。
 *
 * 直接读 `rate_limit_buckets`：那是限流器真正在计数的桶，所以这里的数字
 * 与客户端拿到的 `RateLimit-Remaining` 响应头完全一致——而不是另算一个"估算值"。
 * 过期的桶（窗口已滚过）不参与统计，否则会显示一个永远 0% 的假水位。
 */
async function loadQuota(organizationId: string) {
  const prefix = `${config.deploymentEnv}:`;
  const rows = await prisma.$queryRawUnsafe<BucketRow[]>(
    `SELECT bucket_key, count, window_start, expires_at
     FROM rate_limit_buckets
     WHERE expires_at > now()
       AND (bucket_key LIKE $1 OR bucket_key LIKE $2)`,
    `${prefix}p:%`,
    `${prefix}e:${organizationId}:%`,
  );

  // PUBLIC_RATE_LIMITS 是「路由 → 规则」的表，而 bucket_key 里存的是规则自带的 scope
  // （challenge/activate/heartbeat…），所以这里必须按 rule.scope 建索引，不能按路由名。
  const rules = Object.entries(PUBLIC_RATE_LIMITS).map(([route, rule]) => ({ route, ...rule }));
  const limitByScope = new Map<string, number>(rules.map((rule) => [rule.scope, rule.limit]));
  const windowByScope = new Map<string, number>(rules.map((rule) => [rule.scope, rule.windowSeconds]));

  const productIds = new Set<string>();
  for (const row of rows) {
    const parsed = parseBucketKey(row.bucket_key, prefix);
    if (parsed?.kind === "product") productIds.add(parsed.id);
  }
  const products = productIds.size
    ? await prisma.products.findMany({
        where: { id: { in: [...productIds] } },
        select: { id: true, name: true, code: true },
      })
    : [];
  const productName = new Map(products.map((item) => [item.id, item.name]));

  const items = rows
    .map((row) => {
      const parsed = parseBucketKey(row.bucket_key, prefix);
      if (!parsed) return null;
      const limit = limitByScope.get(parsed.scope);
      const windowSeconds = windowByScope.get(parsed.scope);
      // 规则表里没有的 scope 说明桶是旧版本留下的，直接不显示，免得给出错的额度。
      if (limit === undefined || windowSeconds === undefined) return null;

      const used = Number(row.count);
      const ratio = Math.round((used / limit) * 10_000) / 10_000;
      return {
        scope: parsed.scope,
        kind: parsed.kind,
        target: parsed.kind === "product" ? (productName.get(parsed.id) ?? parsed.id) : "组织级",
        targetId: parsed.id,
        limit,
        windowSeconds,
        used,
        remaining: Math.max(0, limit - used),
        usedRatio: ratio,
        level: ratio >= QUOTA_CRITICAL_RATIO ? "critical" : ratio >= QUOTA_WARN_RATIO ? "warn" : "ok",
        resetSeconds: Math.max(0, Math.ceil((row.expires_at.getTime() - Date.now()) / 1000)),
        windowStart: row.window_start.toISOString(),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.usedRatio - a.usedRatio || a.scope.localeCompare(b.scope))
    .slice(0, 40);

  const hottest = items[0] ?? null;
  return {
    items,
    // 顶部卡片只关心「最紧的那一个桶」，让开发者一眼看到离 429 还有多远。
    hottest: hottest
      ? { scope: hottest.scope, target: hottest.target, usedRatio: hottest.usedRatio, level: hottest.level }
      : null,
    rules: rules.map((rule) => ({
      route: rule.route,
      scope: rule.scope,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    })),
  };
}

/** `sandbox:p:<uuid>:activations` → {kind:"product", id, scope} */
function parseBucketKey(
  key: string,
  prefix: string,
): { kind: "product" | "org"; id: string; scope: string } | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const parts = rest.split(":");
  if (parts[0] === "p" && parts.length === 3) {
    return { kind: "product", id: parts[1], scope: parts[2] };
  }
  if (parts[0] === "e" && parts.length === 3) {
    return { kind: "org", id: parts[1], scope: parts[2] };
  }
  return null;
}