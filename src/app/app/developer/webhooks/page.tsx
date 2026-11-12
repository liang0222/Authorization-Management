"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { DeliveryStatusBadge, ToneBadge, type Tone } from "@/components/app/status-badge";
import {
  CreateWebhookDialog,
  EditWebhookDialog,
  WEBHOOK_STATUS_LABEL,
  type WebhookRow,
} from "@/components/developer/webhook-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery } from "@/lib/client/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Lookups, PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, Tone> = { active: "success", disabled: "warning", archived: "neutral" };

function WebhooksInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, session, status: sessionStatus } = useSession();

  const canRead = hasPermission("webhook:read");
  const canWrite = hasPermission("webhook:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const productId = params.get("productId") ?? "";
  const status = params.get("status") ?? "";

  const [search, setSearch] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookRow | null>(null);
  const [toggling, setToggling] = useState<WebhookRow | null>(null);
  const [archiving, setArchiving] = useState<WebhookRow | null>(null);

  const query = buildQuery({ page, pageSize, q, productId, status });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<WebhookRow>>(
    canRead ? `/api/v1/admin/webhooks${query}` : null,
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
    router.replace(pathname, { scroll: false });
  };

  const toggleStatus = async (row: WebhookRow) => {
    const nextStatus = row.status === "active" ? "disabled" : "active";
    await apiRequest(`/api/v1/admin/webhooks/${row.id}`, { method: "PATCH", body: { status: nextStatus } });
    toast.success(nextStatus === "disabled" ? "端点已停用" : "端点已启用", {
      description:
        nextStatus === "disabled"
          ? "停用后不再投递新事件，已有的投递记录保留。"
          : "端点恢复接收新事件，历史失败记录不会自动重试。",
    });
    refresh();
  };

  const archive = async (row: WebhookRow) => {
    await apiRequest(`/api/v1/admin/webhooks/${row.id}`, { method: "DELETE" });
    toast.success("端点已归档", { description: "归档后不再接收事件，历史投递记录仍可查询。" });
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
  if (productId) {
    const product = lookups.data?.products.find((item) => item.id === productId);
    chips.push({
      label: "产品",
      value: product?.name ?? productId,
      onRemove: () => updateParams((next) => next.delete("productId")),
    });
  }
  if (status) {
    chips.push({
      label: "状态",
      value: WEBHOOK_STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<WebhookRow>[] = useMemo(
    () => [
      {
        key: "url",
        header: "投递地址",
        cell: (row) => (
          <div className="min-w-0">
            <Link
              href={`/app/developer/webhooks/${row.id}`}
              className="block truncate font-mono text-xs text-foreground underline-offset-4 hover:underline"
            >
              {row.url}
            </Link>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {row.product?.name ?? "未知产品"} · 订阅 {row.eventTypes.length} 个事件
            </p>
          </div>
        ),
      },
      {
        key: "events",
        header: "订阅事件",
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.eventTypes.slice(0, 2).map((event) => (
              <span key={event} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {event}
              </span>
            ))}
            {row.eventTypes.length > 2 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                    +{row.eventTypes.length - 2}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[240px]">
                  {row.eventTypes.slice(2).map((event) => (
                    <span key={event} className="block font-mono text-[11px]">
                      {event}
                    </span>
                  ))}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ),
        width: "200px",
      },
      {
        key: "last7d",
        header: "近 7 天投递",
        cell: (row) => (
          <div className="flex items-center gap-1">
            <ToneBadge tone={row.last7d.succeeded > 0 ? "success" : "neutral"} dot={false}>
              成功 {row.last7d.succeeded}
            </ToneBadge>
            <ToneBadge tone={row.last7d.failed > 0 ? "danger" : "neutral"} dot={false}>
              失败 {row.last7d.failed}
            </ToneBadge>
          </div>
        ),
        width: "160px",
      },
      {
        key: "lastDelivery",
        header: "最近投递",
        cell: (row) =>
          row.lastDelivery ? (
            <div className="flex items-center gap-1.5">
              <DeliveryStatusBadge status={row.lastDelivery.status} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-[10px] text-muted-foreground">
                    {formatRelative(row.lastDelivery.createdAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {formatDateTime(row.lastDelivery.createdAt, session?.organization.timezone)}
                  {row.lastDelivery.responseStatus ? ` · HTTP ${row.lastDelivery.responseStatus}` : ""}
                </TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">还没有投递</span>
          ),
        width: "170px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={STATUS_TONE[row.status] ?? "neutral"}>
            {WEBHOOK_STATUS_LABEL[row.status] ?? row.status}
          </ToneBadge>
        ),
        width: "90px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <div className="flex items-center justify-end gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" asChild>
                  <Link href={`/app/developer/webhooks/${row.id}`} aria-label={`查看 ${row.url} 的投递记录`}>
                    <ExternalLink className="size-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>查看投递记录</TooltipContent>
            </Tooltip>
            {canWrite ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7" aria-label={`端点 ${row.url} 的操作菜单`}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => setEditing(row)} disabled={row.status === "archived"}>
                    <Pencil className="size-3.5" /> 编辑地址与事件
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setToggling(row)} disabled={row.status === "archived"}>
                    {row.status === "active" ? (
                      <>
                        <PowerOff className="size-3.5" /> 停用端点
                      </>
                    ) : (
                      <>
                        <Power className="size-3.5" /> 启用端点
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => setArchiving(row)}
                    disabled={row.status === "archived"}
                    variant="destructive"
                  >
                    <Trash2 className="size-3.5" /> 归档端点
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ),
        width: "90px",
      },
    ],
    [canWrite, session?.organization.timezone],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "开发者中心" }, { label: "Webhook" }]}
        title="Webhook"
        description="授权生命周期事件会推送到你的接收端：激活、续费、暂停、吊销、到期与设备变更。每次投递都带签名，失败会按退避重试。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 个端点
            </span>
          ) : null
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading || !canRead}>
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
            </Button>
            {canWrite ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-3.5" /> 新建端点
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="size-3.5" /> 新建端点
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>当前角色没有 webhook:write 权限</TooltipContent>
              </Tooltip>
            )}
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
          searchPlaceholder="按投递地址搜索…"
          chips={chips}
          onReset={resetFilters}
          filters={
            <>
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
                <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按产品筛选 Webhook">
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
                <SelectTrigger size="sm" className="h-8 w-[120px] text-xs" aria-label="按端点状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="active">启用中</SelectItem>
                  <SelectItem value="disabled">已停用</SelectItem>
                  <SelectItem value="archived">已归档</SelectItem>
                </SelectContent>
              </Select>
            </>
          }
        />

        {denied ? (
          <div className="p-4">
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title="没有查看 Webhook 的权限"
              description="需要 webhook:read 权限，接口同样会拒绝这次请求。"
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
              caption="Webhook 端点列表"
              empty={
                <EmptyState
                  icon={<Webhook className="size-5" />}
                  title={chips.length > 0 ? "没有符合条件的端点" : "还没有 Webhook 端点"}
                  description={
                    chips.length > 0
                      ? "换一个地址关键词、产品或状态，或清空筛选。"
                      : "配置端点后，授权事件会自动推送到你的系统，不用轮询。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="size-3.5" /> 新建端点
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
        <>
          <CreateWebhookDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            lookups={lookups.data ?? undefined}
            onCreated={refresh}
          />
          <EditWebhookDialog
            webhook={editing}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            onSaved={refresh}
          />
          <ConfirmDialog
            open={Boolean(toggling)}
            onOpenChange={(open) => {
              if (!open) setToggling(null);
            }}
            title={toggling?.status === "active" ? "停用这个端点？" : "重新启用这个端点？"}
            description={
              toggling
                ? `${toggling.url}。${
                    toggling.status === "active"
                      ? "停用后不再投递新事件，已有记录保留。"
                      : "启用后恢复接收新事件。"
                  }`
                : ""
            }
            confirmLabel={toggling?.status === "active" ? "停用" : "启用"}
            tone={toggling?.status === "active" ? "danger" : "default"}
            onConfirm={async () => {
              if (toggling) await toggleStatus(toggling);
              setToggling(null);
            }}
          />
          <ConfirmDialog
            open={Boolean(archiving)}
            onOpenChange={(open) => {
              if (!open) setArchiving(null);
            }}
            title="归档这个端点？"
            description={archiving ? `${archiving.url} 归档后不再接收事件，历史投递记录仍可查询。` : ""}
            confirmLabel="归档"
            tone="danger"
            onConfirm={async () => {
              if (archiving) await archive(archiving);
              setArchiving(null);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

export default function WebhooksPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <WebhooksInner />
    </Suspense>
  );
}
