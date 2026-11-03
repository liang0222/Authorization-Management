"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Gauge,
  Percent,
  RefreshCw,
  Route,
  ServerCrash,
  Timer,
  X,
} from "lucide-react";
import { PageHeader, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { BarChart } from "@/components/app/charts";
import { EmptyState, DetailSkeleton } from "@/components/app/feedback";
import { ToneBadge } from "@/components/app/status-badge";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { buildQuery } from "@/lib/client/api";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import type { Lookups } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 开发者用量分析（规格 27.12，P1-6）。
 *
 * 这一页回答三个问题，所以分三块：
 * 「我的客户端稳不稳」→ 成功率、延迟分位、每日趋势；
 * 「错在哪儿」→ 错误码分布 + 哪个路由在报错；
 * 「离被限流还有多远」→ 配额水位（直接读限流器自己的桶，与 RateLimit-Remaining 一致）。
 *
 * 口径全在服务端算（成功率、占比、水位档位），前端只负责呈现：
 * 否则同一份数据在不同页面会出现两种算法、两个数字。
 */

interface UsageResponse {
  range: { days: number; timezone: string };
  overview: {
    totalRequests: number;
    successCount: number;
    successRate: number;
    requestsPerDay: number;
    latency: { p50: number | null; p95: number | null; p99: number | null; avg: number | null; max: number | null };
  };
  daily: Array<{
    date: string;
    total: number;
    succeeded: number;
    clientErrors: number;
    serverErrors: number;
    rateLimited: number;
    successRate: number | null;
    p50: number | null;
    p95: number | null;
    avgLatency: number | null;
  }>;
  errors: Array<{ code: string; status: number; count: number; share: number; lastSeenAt: string }>;
  routes: Array<{ route: string; method: string; count: number; share: number; failureRate: number; p95: number | null }>;
  products: Array<{
    productId: string | null;
    productCode: string | null;
    productName: string;
    count: number;
    share: number;
    failureRate: number;
    p95: number | null;
  }>;
  quota: {
    items: Array<{
      scope: string;
      kind: "product" | "org";
      target: string;
      targetId: string;
      limit: number;
      windowSeconds: number;
      used: number;
      remaining: number;
      usedRatio: number;
      level: "ok" | "warn" | "critical";
      resetSeconds: number;
      windowStart: string;
    }>;
    hottest: { scope: string; target: string; usedRatio: number; level: "ok" | "warn" | "critical" } | null;
    rules: Array<{ route: string; scope: string; limit: number; windowSeconds: number }>;
  };
}

const DAY_OPTIONS = [7, 14, 30, 90];

const QUOTA_LEVEL_LABEL: Record<"ok" | "warn" | "critical", string> = {
  ok: "正常",
  warn: "偏高",
  critical: "接近上限",
};

const QUOTA_LEVEL_TONE: Record<"ok" | "warn" | "critical", "success" | "warning" | "danger"> = {
  ok: "success",
  warn: "warning",
  critical: "danger",
};

/** 延迟分位横条：数值都以「最慢的那个」为满格，方便一眼看出 P99 离峰值多远。 */
function LatencyBars({ latency }: { latency: UsageResponse["overview"]["latency"] }) {
  const rows = [
    { label: "P50", value: latency.p50, hint: "一半请求快于此值" },
    { label: "P95", value: latency.p95, hint: "95% 请求快于此值，通常作为 SLA 口径" },
    { label: "P99", value: latency.p99, hint: "最慢的 1%" },
    { label: "平均", value: latency.avg, hint: "会被极慢请求拉高，不要单独用" },
    { label: "峰值", value: latency.max, hint: "区间内最慢的一次" },
  ];
  const max = Math.max(1, ...rows.map((row) => row.value ?? 0));

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => {
        const width = row.value === null ? 0 : Math.max(2, (row.value / max) * 100);
        return (
          <li key={row.label} className="grid grid-cols-[52px_1fr_76px] items-center gap-3">
            <span className="text-xs font-medium text-foreground">{row.label}</span>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                style={{ width: `${width}%` }}
                aria-hidden
              />
              <span className="sr-only">{`${row.label} ${row.value ?? "无数据"} 毫秒`}</span>
            </div>
            <span className="tabular text-right text-xs text-muted-foreground">
              {row.value === null ? "—" : `${formatNumber(row.value)} ms`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StatTile({
  icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden>{icon}</span>
        {label}
      </div>
      <p
        className={cn(
          "tabular mt-1 text-lg font-semibold tracking-tight",
          tone === "danger" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function UsageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, status: sessionStatus, session } = useSession();

  const canRead = hasPermission("verification:read");
  const denied = sessionStatus === "ready" && !canRead;

  const daysParam = Number(params.get("days") ?? 14);
  const days = DAY_OPTIONS.includes(daysParam) ? daysParam : 14;
  const productId = params.get("productId") ?? "";

  const query = buildQuery({ days, productId });
  const { data, error, isLoading, refresh } = useResource<UsageResponse>(
    canRead ? `/api/v1/admin/usage${query}` : null,
  );
  const lookups = useResource<Lookups>(canRead ? "/api/v1/admin/lookups" : null);

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const searchString = next.toString();
    router.replace(searchString ? `${pathname}?${searchString}` : pathname, { scroll: false });
  };

  const chips: Array<{ label: string; value: string; onRemove: () => void }> = [];
  if (productId) {
    const product = lookups.data?.products.find((item) => item.id === productId);
    chips.push({
      label: "产品",
      value: product?.name ?? productId,
      onRemove: () => updateParams((next) => next.delete("productId")),
    });
  }
  if (days !== 14) {
    chips.push({
      label: "时间范围",
      value: `近 ${days} 天`,
      onRemove: () => updateParams((next) => next.delete("days")),
    });
  }

  const overview = data?.overview;
  const daily = data?.daily ?? [];
  const quota = data?.quota;

  const errorColumns: DataColumn<UsageResponse["errors"][number]>[] = [
    {
      key: "code",
      header: "错误码",
      cell: (row) => <span className="font-mono text-xs">{row.code}</span>,
    },
    {
      key: "status",
      header: "HTTP",
      cell: (row) => <span className="tabular text-xs text-muted-foreground">{row.status}</span>,
    },
    {
      key: "count",
      header: "次数",
      align: "right",
      cell: (row) => <span className="tabular text-xs">{formatNumber(row.count)}</span>,
    },
    {
      key: "share",
      header: "占总请求",
      align: "right",
      className: "hidden sm:table-cell",
      headerClassName: "hidden sm:table-cell",
      cell: (row) => <span className="tabular text-xs text-muted-foreground">{formatPercent(row.share, 1)}</span>,
    },
    {
      key: "lastSeenAt",
      header: "最近一次",
      className: "hidden md:table-cell",
      headerClassName: "hidden md:table-cell",
      cell: (row) => (
        <span className="text-xs text-muted-foreground">
          {formatDateTime(row.lastSeenAt, session?.organization.timezone)}
        </span>
      ),
    },
  ];

  const routeColumns: DataColumn<UsageResponse["routes"][number]>[] = [
    {
      key: "route",
      header: "端点",
      width: "50%",
      cell: (row) => (
        <div className="flex min-w-0 max-w-[240px] items-center gap-2">
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {row.method}
          </span>
          <span className="truncate font-mono text-xs" title={row.route}>
            {row.route}
          </span>
        </div>
      ),
    },
    {
      key: "count",
      header: "请求数",
      align: "right",
      cell: (row) => <span className="tabular text-xs">{formatNumber(row.count)}</span>,
    },
    {
      key: "share",
      header: "占比",
      align: "right",
      className: "hidden sm:table-cell",
      headerClassName: "hidden sm:table-cell",
      cell: (row) => <span className="tabular text-xs text-muted-foreground">{formatPercent(row.share, 1)}</span>,
    },
    {
      key: "failureRate",
      header: "失败率",
      align: "right",
      cell: (row) => (
        <span className={cn("tabular text-xs", row.failureRate >= 0.2 ? "text-destructive" : "text-muted-foreground")}>
          {formatPercent(row.failureRate, 1)}
        </span>
      ),
    },
    {
      key: "p95",
      header: "P95",
      align: "right",
      className: "hidden md:table-cell",
      headerClassName: "hidden md:table-cell",
      cell: (row) => (
        <span className="tabular text-xs text-muted-foreground">{row.p95 === null ? "—" : `${row.p95} ms`}</span>
      ),
    },
  ];

  const productColumns: DataColumn<UsageResponse["products"][number]>[] = [
    {
      key: "productName",
      header: "产品",
      cell: (row) => (
        <div className="min-w-0 max-w-[200px]">
          <p className="truncate text-sm font-medium">{row.productName}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{row.productCode ?? "—"}</p>
        </div>
      ),
    },
    {
      key: "count",
      header: "请求数",
      align: "right",
      cell: (row) => <span className="tabular text-xs">{formatNumber(row.count)}</span>,
    },
    {
      key: "share",
      header: "占比",
      align: "right",
      className: "hidden sm:table-cell",
      headerClassName: "hidden sm:table-cell",
      cell: (row) => <span className="tabular text-xs text-muted-foreground">{formatPercent(row.share, 1)}</span>,
    },
    {
      key: "failureRate",
      header: "失败率",
      align: "right",
      cell: (row) => (
        <span className={cn("tabular text-xs", row.failureRate >= 0.2 ? "text-destructive" : "text-muted-foreground")}>
          {formatPercent(row.failureRate, 1)}
        </span>
      ),
    },
    {
      key: "p95",
      header: "P95",
      align: "right",
      className: "hidden md:table-cell",
      headerClassName: "hidden md:table-cell",
      cell: (row) => (
        <span className="tabular text-xs text-muted-foreground">{row.p95 === null ? "—" : `${row.p95} ms`}</span>
      ),
    },
  ];

  const quotaColumns: DataColumn<NonNullable<typeof quota>["items"][number]>[] = [
    {
      key: "scope",
      header: "端点族",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-xs">{row.scope}</p>
          <p className="truncate text-[11px] text-muted-foreground">{row.target}</p>
        </div>
      ),
    },
    {
      key: "usage",
      header: "本窗口用量",
      cell: (row) => (
        <div className="flex min-w-[110px] items-center gap-2">
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                row.level === "critical" ? "bg-destructive" : row.level === "warn" ? "bg-warning" : "bg-success",
              )}
              style={{ width: `${Math.min(100, row.usedRatio * 100)}%` }}
              aria-hidden
            />
          </div>
          <span className="tabular shrink-0 text-[11px] text-muted-foreground">
            {row.used}/{row.limit}
          </span>
        </div>
      ),
    },
    {
      key: "level",
      header: "状态",
      cell: (row) => <ToneBadge tone={QUOTA_LEVEL_TONE[row.level]}>{QUOTA_LEVEL_LABEL[row.level]}</ToneBadge>,
    },
    {
      key: "reset",
      header: "窗口重置",
      align: "right",
      className: "hidden sm:table-cell",
      headerClassName: "hidden sm:table-cell",
      cell: (row) => <span className="tabular text-xs text-muted-foreground">{row.resetSeconds} 秒后</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[
          { label: "开发者中心", href: "/app/developer/api" },
          { label: "用量分析" },
        ]}
        title="用量分析"
        description="客户端调用公开 API 的真实延迟分位、错误构成与限流配额。数据来自服务端请求日志与限流器自己的计数桶，不是估算。"
        meta={
          data ? (
            <>
              <span>
                统计区间 近 {data.range.days} 天 · 时区 {data.range.timezone}
              </span>
              <span className="text-muted-foreground">共 {formatNumber(data.overview.totalRequests)} 次调用</span>
            </>
          ) : null
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
            <RefreshCw aria-hidden className={cn("size-3.5", isLoading && "animate-spin")} />
            刷新
          </Button>
        }
      />

      {denied ? (
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertTitle>当前账号没有查看用量的权限</AlertTitle>
          <AlertDescription>
            需要权限码 <code className="font-mono text-xs">verification:read</code>
            。用量数据就是验证日志的聚合视图，所以共用同一个只读权限；请在「管理员与角色」里为该角色勾选后刷新本页。
          </AlertDescription>
        </Alert>
      ) : null}

      {canRead ? (
        <>
          <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1.5">
              {chips.length ? (
                chips.map((chip) => (
                  <span
                    key={`${chip.label}-${chip.value}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-1 pl-2 text-[11px]"
                  >
                    <span className="text-muted-foreground">{chip.label}</span>
                    <span className="font-medium text-foreground">{chip.value}</span>
                    <button
                      type="button"
                      onClick={chip.onRemove}
                      aria-label={`移除筛选 ${chip.label}`}
                      className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-[11px] text-muted-foreground">全部产品 · 近 14 天</span>
              )}
              {chips.length ? (
                <button
                  type="button"
                  onClick={() => router.replace(pathname, { scroll: false })}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  清空
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={String(days)} onValueChange={(value) => updateParams((next) => next.set("days", value))}>
                <SelectTrigger size="sm" className="h-8 w-[124px] text-xs" aria-label="时间范围">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      近 {option} 天
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={productId || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("productId");
                    else next.set("productId", value);
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[168px] text-xs" aria-label="产品">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部产品</SelectItem>
                  {(lookups.data?.products ?? []).map((product) => (
                    <SelectItem key={product.id} value={product.id}>
                      {product.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden />
              <AlertTitle>用量数据加载失败</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}

          {!data && isLoading ? (
            <DetailSkeleton />
          ) : overview ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                icon={<Activity className="size-3.5" />}
                label="总请求数"
                value={formatNumber(overview.totalRequests)}
                hint={`日均 ${formatNumber(overview.requestsPerDay)} 次`}
              />
              <StatTile
                icon={<Percent className="size-3.5" />}
                label="成功率"
                value={formatPercent(overview.successRate, 1)}
                hint={`成功 ${formatNumber(overview.successCount)} 次`}
                tone={overview.successRate < 0.9 ? "warning" : "default"}
              />
              <StatTile
                icon={<Gauge className="size-3.5" />}
                label="P95 延迟"
                value={overview.latency.p95 === null ? "—" : `${formatNumber(overview.latency.p95)} ms`}
                hint={`中位数 ${overview.latency.p50 === null ? "—" : `${overview.latency.p50} ms`}`}
                tone={overview.latency.p95 !== null && overview.latency.p95 > 500 ? "warning" : "default"}
              />
              <StatTile
                icon={<Timer className="size-3.5" />}
                label="峰值延迟"
                value={overview.latency.max === null ? "—" : `${formatNumber(overview.latency.max)} ms`}
                hint={`平均 ${overview.latency.avg === null ? "—" : `${overview.latency.avg} ms`}`}
              />
            </div>
          ) : null}

          <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Section
              className="flex flex-col"
              contentClassName="flex flex-1 flex-col"
              title="每日调用量"
              description="柱高是当日总请求，顶部深色段是失败（4xx / 5xx）。悬停可看精确数值。"
            >
              {daily.length ? (
                <BarChart
                  className="flex-1"
                  data={daily.map((row) => ({
                    label: row.date,
                    value: row.total,
                    secondary: row.clientErrors + row.serverErrors,
                  }))}
                  valueLabel="请求"
                  height={180}
                />
              ) : (
                <EmptyState title="区间内没有调用记录" description="客户端接入并发出第一次请求后，这里就会出现数据。" />
              )}
            </Section>

            <Section title="延迟分位" description="毫秒，全部来自服务端记录的耗时。">
              {overview ? <LatencyBars latency={overview.latency} /> : <DetailSkeleton />}
            </Section>
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <Section
              title="错误码分布"
              description="按次数降序。占比是「占区间内全部请求」，不是占错误数。"
            >
              <DataTable
                columns={errorColumns}
                rows={data?.errors ?? null}
                rowKey={(row) => row.code}
                loading={isLoading}
                empty={<EmptyState title="没有失败请求" description="区间内所有调用都成功了。" />}
              />
            </Section>

            <Section title="调用最多的端点" description="失败率超过 20% 会标红，通常意味着客户端用法或授权状态有问题。">
              <DataTable
                columns={routeColumns}
                rows={data?.routes ?? null}
                rowKey={(row) => `${row.method}-${row.route}`}
                loading={isLoading}
                empty={<EmptyState title="暂无端点统计" description="区间内没有调用记录。" />}
              />
            </Section>
          </div>

          <Section title="按产品分布" description="多产品共用一套接入时，用它确认是哪个产品在报错或变慢。">
            <DataTable
              columns={productColumns}
              rows={data?.products ?? null}
              rowKey={(row) => row.productId ?? row.productCode ?? row.productName}
              loading={isLoading}
              empty={<EmptyState title="暂无产品统计" description="区间内没有调用记录。" />}
            />
          </Section>

          <Section
            title="限流配额水位"
            description={`当前窗口（60 秒）的实时用量，直接读限流器的计数桶，与响应头 RateLimit-Remaining 完全一致。只有还在窗口内的桶会显示，所以这里可能是空的。`}
            actions={
              quota?.hottest ? (
                <ToneBadge tone={QUOTA_LEVEL_TONE[quota.hottest.level]}>
                  {`最紧：${quota.hottest.scope} ${formatPercent(quota.hottest.usedRatio, 0)}`}
                </ToneBadge>
              ) : null
            }
          >
            {quota?.hottest && quota.hottest.level !== "ok" ? (
              <Alert variant={quota.hottest.level === "critical" ? "destructive" : "default"} className="mb-3">
                <ServerCrash aria-hidden />
                <AlertTitle>
                  {quota.hottest.target} 的 {quota.hottest.scope} 已用掉 {formatPercent(quota.hottest.usedRatio, 0)}
                </AlertTitle>
                <AlertDescription>
                  继续这个速率会在窗口内被 429。客户端应读取响应头 <code className="font-mono text-xs">retry-after</code>
                  ，并按它退避重试；长期超限请调高套餐或降低心跳频率。
                </AlertDescription>
              </Alert>
            ) : null}

            <DataTable
              columns={quotaColumns}
              rows={quota?.items ?? null}
              rowKey={(row) => `${row.kind}-${row.targetId}-${row.scope}`}
              loading={isLoading}
              empty={
                <EmptyState
                  title="当前没有进行中的限流窗口"
                  description="限流窗口是 60 秒的固定窗口，窗口过期后计数桶会被清理。发起几次客户端调用后回到本页即可看到实时水位。"
                />
              }
            />

            {quota?.rules?.length ? (
              <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Route aria-hidden className="size-3.5" />
                  公开端点限额（
                  {quota.rules.length} 条规则，单产品单 IP / 窗口）
                </p>
                <div className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                  {quota.rules.map((rule) => (
                    <div key={rule.route} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-muted-foreground">{rule.route}</span>
                      <span className="tabular shrink-0 text-foreground">
                        {rule.limit} / {rule.windowSeconds}s
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Section>
        </>
      ) : null}
    </div>
  );
}

export default function UsagePage() {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <UsageInner />
    </Suspense>
  );
}