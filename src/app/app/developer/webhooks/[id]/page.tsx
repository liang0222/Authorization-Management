"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Inbox, RefreshCw, RotateCcw, Send, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { DeliveryStatusBadge, HttpStatusBadge, ToneBadge } from "@/components/app/status-badge";
import { CopyButton } from "@/components/app/copy-button";
import { WEBHOOK_STATUS_LABEL } from "@/components/developer/webhook-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery, errorMessage } from "@/lib/client/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface DeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

interface TestDeliveryResponse {
  deliveryId: string;
  eventId: string;
  outcome: "succeeded" | "failed" | "dead" | "skipped";
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  message: string;
}

interface DeliveriesResponse {
  items: DeliveryRow[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  endpoint: { id: string; url: string; status: string };
}

const DELIVERY_STATUSES = [
  { value: "pending", label: "待投递" },
  { value: "delivering", label: "投递中" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败（可重试）" },
  { value: "dead", label: "已终止" },
];

function DeliveriesInner() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const routeParams = useParams<{ id: string }>();
  const id = routeParams?.id;
  const { hasPermission, session, status: sessionStatus } = useSession();

  const canRead = hasPermission("webhook:read");
  const canWrite = hasPermission("webhook:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";

  const [search, setSearch] = useState(q);
  const [replaying, setReplaying] = useState<DeliveryRow | null>(null);
  const [testing, setTesting] = useState(false);

  const query = buildQuery({ page, pageSize, q, status });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<DeliveriesResponse>(
    canRead && id ? `/api/v1/admin/webhooks/${id}/deliveries${query}` : null,
  );

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const searchString = next.toString();
    router.replace(searchString ? `${pathname}?${searchString}` : pathname, { scroll: false });
  };

  /**
   * 发送测试事件：让端点立刻收到一条 webhook.test。
   * 同步返回结果（HTTP 状态码 + 耗时），比等 worker 轮询更适合联调。
   */
  const sendTest = async () => {
    if (!id) return;
    setTesting(true);
    try {
      const result = await apiRequest<TestDeliveryResponse>(`/api/v1/admin/webhooks/${id}/test`, {
        method: "POST",
      });
      if (result.outcome === "succeeded") {
        toast.success("测试投递成功", { description: `${result.message} 耗时 ${result.durationMs}ms` });
      } else {
        toast.error("测试投递未成功", { description: result.message });
      }
      refresh();
    } catch (caught) {
      toast.error("测试投递失败", { description: errorMessage(caught) });
    } finally {
      setTesting(false);
    }
  };

  const replay = async (row: DeliveryRow) => {
    await apiRequest(`/api/v1/admin/webhook-deliveries/${row.id}/replay`, { method: "POST" });
    toast.success("已重新入队", {
      description: `${row.eventType} 将按退避策略重新投递，可在列表里观察状态变化。`,
    });
    refresh();
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
  if (status) {
    chips.push({
      label: "状态",
      value: DELIVERY_STATUSES.find((item) => item.value === status)?.label ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<DeliveryRow>[] = useMemo(
    () => [
      {
        key: "createdAt",
        header: "创建时间",
        cell: (row) => (
          <span className="tabular whitespace-nowrap text-[11px] text-muted-foreground">
            {formatDateTime(row.createdAt, session?.organization.timezone)}
          </span>
        ),
        width: "150px",
      },
      {
        key: "eventType",
        header: "事件",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] text-foreground">{row.eventType}</p>
            <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="truncate font-mono">{row.eventId}</span>
              <CopyButton value={row.eventId} label="复制 event_id" tooltip="复制 event_id" />
            </p>
          </div>
        ),
      },
      {
        key: "status",
        header: "投递状态",
        cell: (row) => (
          <div className="flex flex-col items-start gap-1">
            <DeliveryStatusBadge status={row.status} />
            <span className="text-[10px] text-muted-foreground">第 {row.attemptCount} 次尝试</span>
          </div>
        ),
        width: "130px",
      },
      {
        key: "responseStatus",
        header: "响应",
        cell: (row) =>
          row.responseStatus ? (
            <HttpStatusBadge status={row.responseStatus} />
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          ),
        width: "90px",
      },
      {
        key: "lastError",
        header: "错误信息",
        cell: (row) =>
          row.lastError ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="line-clamp-1 cursor-help font-mono text-[11px] text-destructive">
                  {row.lastError}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[360px] break-all">{row.lastError}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          ),
      },
      {
        key: "deliveredAt",
        header: "送达 / 下次重试",
        cell: (row) => (
          <span className="text-[11px] text-muted-foreground">
            {row.deliveredAt
              ? formatDateTime(row.deliveredAt, session?.organization.timezone)
              : row.nextAttemptAt
                ? `重试 ${formatDateTime(row.nextAttemptAt, session?.organization.timezone)}`
                : "—"}
          </span>
        ),
        width: "180px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) =>
          canWrite ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => setReplaying(row)}
              disabled={row.status === "delivering"}
            >
              <RotateCcw className="size-3.5" /> 重投
            </Button>
          ) : null,
        width: "80px",
      },
    ],
    [canWrite, session?.organization.timezone],
  );

  const endpoint = data?.endpoint;

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[
          { label: "开发者中心" },
          { label: "Webhook", href: "/app/developer/webhooks" },
          { label: "投递记录" },
        ]}
        title="投递记录"
        description={endpoint ? endpoint.url : "查看这个端点的每一次事件投递与重试结果。"}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            {endpoint ? (
              <ToneBadge tone={endpoint.status === "active" ? "success" : "neutral"}>
                {WEBHOOK_STATUS_LABEL[endpoint.status] ?? endpoint.status}
              </ToneBadge>
            ) : null}
            {data ? (
              <span className="text-xs text-muted-foreground">
                共 <span className="tabular font-medium text-foreground">{formatNumber(data.total)}</span> 次投递
              </span>
            ) : null}
          </div>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/developer/webhooks">
                <ArrowLeft className="size-3.5" /> 返回端点列表
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading || !canRead}>
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
            </Button>
            {canWrite ? (
              <Button
                size="sm"
                onClick={sendTest}
                disabled={testing || endpoint?.status !== "active"}
                title={endpoint?.status !== "active" ? "端点已停用，启用后才能测试投递" : undefined}
              >
                {testing ? <RefreshCw className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                发送测试事件
              </Button>
            ) : null}
          </>
        }
      />

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
          searchPlaceholder="按事件类型或 event_id 搜索…"
          chips={chips}
          onReset={() => {
            setSearch("");
            router.replace(pathname, { scroll: false });
          }}
          filters={
            <Select
              value={status || "all"}
              onValueChange={(value) =>
                updateParams((next) => {
                  if (value === "all") next.delete("status");
                  else next.set("status", value);
                  next.set("page", "1");
                })
              }
            >
              <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按投递状态筛选">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {DELIVERY_STATUSES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        {denied ? (
          <div className="p-4">
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title="没有查看投递记录的权限"
              description="需要 webhook:read 权限，接口同样会拒绝这次请求。"
              action={
                <Button variant="outline" size="sm" onClick={() => router.push("/app/developer/webhooks")}>
                  返回端点列表
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
              caption="Webhook 投递记录"
              empty={
                <EmptyState
                  icon={<Inbox className="size-5" />}
                  title={chips.length > 0 ? "没有符合条件的投递" : "这个端点还没有投递记录"}
                  description={
                    chips.length > 0
                      ? "换一个事件类型或状态，或清空筛选。"
                      : "当订阅的事件真实发生时，这里会出现第一条投递。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSearch("");
                          router.replace(pathname, { scroll: false });
                        }}
                      >
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

      {canWrite ? (
        <ConfirmDialog
          open={Boolean(replaying)}
          onOpenChange={(open) => {
            if (!open) setReplaying(null);
          }}
          title="重新投递这个事件？"
          description={
            replaying
              ? `${replaying.eventType}（event_id ${replaying.eventId}），当前第 ${replaying.attemptCount} 次尝试。`
              : ""
          }
          confirmLabel="重新投递"
          onConfirm={async () => {
            if (replaying) await replay(replaying);
            setReplaying(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            重投会立即把这条投递放回队列；接收端需要能承受重复事件（请按 event_id 做幂等）。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export default function WebhookDeliveriesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <DeliveriesInner />
    </Suspense>
  );
}
