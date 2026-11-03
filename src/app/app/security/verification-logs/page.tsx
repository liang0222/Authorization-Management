"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Activity, AlertTriangle, Gauge, RefreshCw, ShieldAlert, Timer, X } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { HttpStatusBadge, ToneBadge } from "@/components/app/status-badge";
import { CopyButton } from "@/components/app/copy-button";
import { VerificationLogDrawer, type VerificationLogRow } from "@/components/security/log-drawers";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { buildQuery } from "@/lib/client/api";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import type { Lookups } from "@/lib/types";
import { cn } from "@/lib/utils";

interface VerificationResponse {
  items: VerificationLogRow[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  summary: {
    totalRequests: number;
    successCount: number;
    successRate: number;
    clientErrorCount: number;
    serverErrorCount: number;
    avgLatencyMs: number;
  };
}

const STATUS_BUCKETS = [
  { value: "2xx", label: "2xx 成功" },
  { value: "4xx", label: "4xx 客户端错误" },
  { value: "5xx", label: "5xx 服务端错误" },
  { value: "401", label: "401 鉴权失败" },
  { value: "409", label: "409 冲突" },
  { value: "423", label: "423 已锁定" },
  { value: "429", label: "429 限流" },
];

/** PostgreSQL inet 会以 ::ffff:127.0.0.1 形式返回 IPv4，展示前还原成人能读的写法。 */
function normalizeIp(ip: string | null): string {
  if (!ip) return "—";
  return ip.replace(/^::ffff:/i, "");
}

function StatTile({
  icon,
  label,
  value,
  hint,
  tone,
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
        <span aria-hidden className="text-muted-foreground">
          {icon}
        </span>
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

function VerificationLogsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, session, status: sessionStatus } = useSession();

  const canRead = hasPermission("verification:read");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const productId = params.get("productId") ?? "";
  const statusBucket = params.get("status") ?? "";
  const route = params.get("route") ?? "";

  const [search, setSearch] = useState(q);
  const [routeInput, setRouteInput] = useState(route);
  const [selected, setSelected] = useState<VerificationLogRow | null>(null);

  const query = buildQuery({ page, pageSize, q, productId, status: statusBucket, route });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<VerificationResponse>(
    canRead ? `/api/v1/admin/verification-logs${query}` : null,
  );
  const lookups = useResource<Lookups>(canRead ? "/api/v1/admin/lookups" : null);

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const searchString = next.toString();
    router.replace(searchString ? `${pathname}?${searchString}` : pathname, { scroll: false });
  };

  const resetFilters = () => {
    setSearch("");
    setRouteInput("");
    router.replace(pathname, { scroll: false });
  };

  const chips: FilterChip[] = [];
  if (q) {
    chips.push({
      label: "搜索",
      value: q,
      onRemove: () => {
        setSearch("");
        updateParams((next) => next.delete("q"));
      },
    });
  }
  if (route) {
    chips.push({
      label: "路径",
      value: route,
      onRemove: () => {
        setRouteInput("");
        updateParams((next) => next.delete("route"));
      },
    });
  }
  if (productId) {
    const product = lookups.data?.products.find((item) => item.id === productId);
    chips.push({
      label: "产品",
      value: product?.name ?? productId,
      onRemove: () => updateParams((next) => next.delete("productId")),
    });
  }
  if (statusBucket) {
    const bucket = STATUS_BUCKETS.find((item) => item.value === statusBucket);
    chips.push({
      label: "状态",
      value: bucket?.label ?? statusBucket,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<VerificationLogRow>[] = useMemo(
    () => [
      {
        key: "createdAt",
        header: "时间",
        cell: (row) => (
          <span className="tabular whitespace-nowrap text-[11px] text-muted-foreground">
            {formatDateTime(row.createdAt, session?.organization.timezone)}
          </span>
        ),
        width: "150px",
      },
      {
        key: "request",
        header: "请求",
        cell: (row) => (
          <div className="min-w-0">
            <p className="flex items-center gap-1.5">
              <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] font-semibold text-foreground">
                {row.method}
              </span>
              <span className="truncate font-mono text-[11px] text-foreground">{row.route}</span>
            </p>
            <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="font-mono">{row.requestId}</span>
              <CopyButton value={row.requestId} label="复制 request_id" tooltip="复制 request_id" />
            </p>
          </div>
        ),
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <div className="flex flex-col items-start gap-1">
            <HttpStatusBadge status={row.status} />
            {row.errorCode ? (
              <span className="font-mono text-[10px] text-muted-foreground">{row.errorCode}</span>
            ) : null}
          </div>
        ),
        width: "150px",
      },
      {
        key: "latencyMs",
        header: "延迟",
        align: "right",
        cell: (row) => (
          <span
            className={cn(
              "tabular text-[11px]",
              row.latencyMs > 500 ? "text-destructive" : row.latencyMs > 200 ? "text-warning" : "text-foreground",
            )}
          >
            {row.latencyMs} ms
          </span>
        ),
        width: "80px",
      },
      {
        key: "ip",
        header: "来源 IP",
        cell: (row) => (
          <span className="font-mono text-[11px] text-muted-foreground">{normalizeIp(row.ip)}</span>
        ),
        width: "130px",
      },
      {
        key: "product",
        header: "产品",
        cell: (row) => (
          <span className="truncate text-[11px] text-muted-foreground">{row.productName ?? "—"}</span>
        ),
        width: "130px",
      },
    ],
    [session?.organization.timezone],
  );

  const summary = data?.summary;

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "安全审计" }, { label: "验证日志" }]}
        title="验证日志"
        description="客户端每一次验证、激活、心跳与解绑调用的服务端记录。日志只存请求元数据与结果，不记录授权码、Token 与私钥。"
        meta={
          <span className="text-xs text-muted-foreground">
            当前筛选命中 <span className="tabular font-medium text-foreground">{formatNumber(summary?.totalRequests ?? 0)}</span> 条请求
          </span>
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading || !canRead}>
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          icon={<Activity className="size-3.5" />}
          label="请求总量"
          value={formatNumber(summary?.totalRequests ?? 0)}
          hint="符合当前筛选"
        />
        <StatTile
          icon={<Gauge className="size-3.5" />}
          label="成功率"
          value={summary ? formatPercent(summary.successRate) : "—"}
          hint={summary ? `成功 ${formatNumber(summary.successCount)} 次` : undefined}
        />
        <StatTile
          icon={<AlertTriangle className="size-3.5" />}
          label="4xx 客户端错误"
          value={formatNumber(summary?.clientErrorCount ?? 0)}
          tone="warning"
          hint="密钥错误、设备超限等"
        />
        <StatTile
          icon={<ShieldAlert className="size-3.5" />}
          label="5xx 服务端错误"
          value={formatNumber(summary?.serverErrorCount ?? 0)}
          tone={summary && summary.serverErrorCount > 0 ? "danger" : "default"}
          hint="需要排查服务端"
        />
        <StatTile
          icon={<Timer className="size-3.5" />}
          label="平均延迟"
          value={summary ? `${summary.avgLatencyMs} ms` : "—"}
          hint="仅统计已记录请求"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <FilterBar
          searchValue={search}
          onSearchChange={setSearch}
          onSearchSubmit={() =>
            updateParams((next) => {
              if (search.trim()) next.set("q", search.trim());
              else next.delete("q");
              next.set("page", "1");
            })
          }
          searchPlaceholder="按 request_id 搜索…"
          chips={chips}
          onReset={resetFilters}
          filters={
            <>
              <Input
                value={routeInput}
                onChange={(event) => setRouteInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  updateParams((next) => {
                    if (routeInput.trim()) next.set("route", routeInput.trim());
                    else next.delete("route");
                    next.set("page", "1");
                  });
                }}
                placeholder="路径包含 /activations"
                className="h-8 w-[190px] font-mono text-xs"
                aria-label="按请求路径筛选"
              />
              <Select
                value={statusBucket || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("status");
                    else next.set("status", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按 HTTP 状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {STATUS_BUCKETS.map((bucket) => (
                    <SelectItem key={bucket.value} value={bucket.value}>
                      {bucket.label}
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
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按产品筛选验证日志">
                  <SelectValue placeholder="全部产品" />
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
            </>
          }
        />

        {denied ? (
          <div className="p-4">
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title="没有查看验证日志的权限"
              description="需要 verification:read 权限，接口同样会拒绝这次请求。"
              action={
                <Button variant="outline" size="sm" onClick={() => router.push("/app/dashboard")}>
                  返回数据总览
                </Button>
              }
            />
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={refresh} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={data?.items ?? null}
              rowKey={(row) => row.id}
              loading={isLoading || isRefreshing}
              onRowClick={(row) => setSelected(row)}
              caption="验证日志列表"
              empty={
                <EmptyState
                  icon={<Activity className="size-5" />}
                  title={chips.length > 0 ? "没有符合条件的验证请求" : "还没有验证请求"}
                  description={
                    chips.length > 0
                      ? "换一个 request_id、路径或状态，或清空筛选。"
                      : "客户端第一次调用验证接口后，这里会出现记录。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : null
                  }
                />
              }
            />
            {data ? (
              <PaginationBar
                page={data.page}
                pageCount={data.pageCount}
                total={data.total}
                pageSize={data.pageSize}
                disabled={isLoading || isRefreshing}
                onPageChange={(nextPage) => updateParams((next) => next.set("page", String(nextPage)))}
                onPageSizeChange={(size) =>
                  updateParams((next) => {
                    next.set("pageSize", String(size));
                    next.set("page", "1");
                  })
                }
              />
            ) : null}
          </>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <p className="inline-flex cursor-help items-center gap-1 text-[11px] text-muted-foreground">
            <ToneBadge tone="neutral" dot={false}>
              提示
            </ToneBadge>
            点击任意一行打开详情抽屉
          </p>
        </TooltipTrigger>
        <TooltipContent>抽屉里是这条请求的完整记录与 request_id，便于对照客户端日志。</TooltipContent>
      </Tooltip>

      <VerificationLogDrawer
        row={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        timeZone={session?.organization.timezone}
      />
    </div>
  );
}

export default function VerificationLogsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted/60" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <VerificationLogsInner />
    </Suspense>
  );
}
