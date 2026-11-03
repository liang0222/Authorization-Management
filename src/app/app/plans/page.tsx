"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Package, Pencil, Plus, RefreshCw, ShieldAlert, Ticket, X } from "lucide-react";
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
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import { PlanFormDialog, START_POLICY_LABEL, type PlanFormInitial } from "@/components/catalog/plan-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery } from "@/lib/client/api";
import { durationLabel, formatNumber } from "@/lib/format";
import type { Lookups, PageResult, PlanRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = { active: "启用", disabled: "停用", archived: "已归档" };
const STATUS_TONE: Record<string, Tone> = { active: "success", disabled: "warning", archived: "neutral" };

interface PlanDetailResponse {
  plan: PlanRow & { product: { id: string; name: string; code: string } };
  features: Array<{ code: string; name: string; value_type: string; default_value: unknown }>;
  overrides: Array<{ code: string; value: unknown }>;
  issuedCount: number;
}

function PlansPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, status: sessionStatus } = useSession();

  const canRead = hasPermission("plan:read");
  const canWrite = hasPermission("plan:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const productId = params.get("productId") ?? "";

  const [search, setSearch] = useState(q);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const query = buildQuery({ page, pageSize, q, status, productId });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<PlanRow>>(
    canRead ? `/api/v1/admin/plans${query}` : null,
  );
  const lookups = useResource<Lookups>(canRead ? "/api/v1/admin/lookups" : null);
  const detail = useResource<PlanDetailResponse>(
    canRead && editingId ? `/api/v1/admin/plans/${editingId}` : null,
  );

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

  const setArchived = async (row: PlanRow) => {
    try {
      await apiRequest(`/api/v1/admin/plans/${row.id}`, { method: "PATCH", body: { status: "archived" } });
      toast.success("套餐已归档", { description: "已签发授权继续按原快照生效，归档只是不再可选。" });
      refresh();
    } catch (err) {
      toast.error("归档失败", { description: errorMessageOf(err) });
    }
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
    chips.push({ label: "状态", value: STATUS_LABEL[status] ?? status, onRemove: () => updateParams((next) => next.delete("status")) });
  }
  if (productId) {
    const product = lookups.data?.products.find((item) => item.id === productId);
    chips.push({
      label: "产品",
      value: product?.name ?? productId,
      onRemove: () => updateParams((next) => next.delete("productId")),
    });
  }

  const initial: PlanFormInitial | null = detail.data
    ? {
        id: detail.data.plan.id,
        productId: detail.data.plan.product.id,
        code: detail.data.plan.code,
        name: detail.data.plan.name,
        description: detail.data.plan.description,
        status: detail.data.plan.status,
        unit: detail.data.plan.duration.unit,
        value: detail.data.plan.duration.value,
        startPolicy: detail.data.plan.startPolicy,
        activationDeadlineDays: detail.data.plan.activationDeadlineDays,
        maxDevices: detail.data.plan.maxDevices,
        maxActivationCount: detail.data.plan.maxActivationCount,
        maxSubjects: detail.data.plan.maxSubjects,
        refundActivationOnRelease: detail.data.plan.refundActivationOnRelease,
        offlineAllowed: detail.data.plan.offlineAllowed,
        offlineGraceSeconds: detail.data.plan.offlineGraceSeconds,
        featureOverrides: Object.fromEntries(detail.data.overrides.map((item) => [item.code, item.value])),
      }
    : null;

  const columns: DataColumn<PlanRow>[] = useMemo(
    () => [
      {
        key: "name",
        header: "套餐",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{row.code}</p>
          </div>
        ),
        width: "190px",
      },
      {
        key: "product",
        header: "产品",
        cell: (row) => (
          <Link
            href={`/app/products/${row.product.id}`}
            className="truncate text-xs text-foreground underline-offset-4 hover:underline"
          >
            {row.product.name}
          </Link>
        ),
        width: "150px",
      },
      {
        key: "duration",
        header: "标准周期",
        cell: (row) => (
          <span className="text-xs text-foreground">{durationLabel(row.duration)}</span>
        ),
        width: "170px",
      },
      {
        key: "limits",
        header: "限制",
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  {row.maxDevices} 台
                </ToneBadge>
              </TooltipTrigger>
              <TooltipContent>设备上限：同时保持激活的设备数量</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  {row.maxActivationCount ?? "∞"} 次
                </ToneBadge>
              </TooltipTrigger>
              <TooltipContent>累计激活次数上限，达到后拒绝新激活但已有设备不受影响</TooltipContent>
            </Tooltip>
          </div>
        ),
        width: "150px",
      },
      {
        key: "startPolicy",
        header: "起算方式",
        cell: (row) => (
          <span className="text-[11px] text-muted-foreground">{START_POLICY_LABEL[row.startPolicy] ?? row.startPolicy}</span>
        ),
        width: "120px",
      },
      {
        key: "issued",
        header: "已签发",
        align: "right",
        cell: (row) => (
          <div className="tabular text-right text-xs">
            <span className="font-medium text-foreground">{formatNumber(row.counts.issued)}</span>
            <p className="text-[10px] text-muted-foreground">功能 {row.counts.features}</p>
          </div>
        ),
        width: "90px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={STATUS_TONE[row.status] ?? "neutral"}>{STATUS_LABEL[row.status] ?? row.status}</ToneBadge>
        ),
        width: "88px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`套餐 ${row.name} 的操作菜单`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem asChild>
                <Link href={`/app/licenses?productId=${row.product.id}&planId=${row.id}`}>
                  <Ticket className="size-3.5" /> 查看授权
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/app/licenses?productId=${row.product.id}&planId=${row.id}&issue=1`}>
                  <Plus className="size-3.5" /> 用这个套餐签发
                </Link>
              </DropdownMenuItem>
              {canWrite ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setEditingId(row.id)}>
                    <Pencil className="size-3.5" /> 编辑套餐
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setArchived(row)} disabled={row.status === "archived"}>
                    <X className="size-3.5" /> 归档套餐
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
        width: "60px",
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "业务管理" }, { label: "授权套餐" }]}
        title="授权套餐"
        description="套餐是签发授权时的模板：标准周期、设备上限、功能默认值都从这里带出，签发后成为独立快照。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 个套餐
            </span>
          ) : null
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading || !canRead}>
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
            </Button>
            {canWrite ? (
              <Button
                size="sm"
                onClick={() => {
                  setEditingId(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-3.5" /> 新建套餐
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="size-3.5" /> 新建套餐
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>当前角色没有 plan:write 权限</TooltipContent>
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
          searchPlaceholder="按套餐名称或编码搜索…"
          chips={chips}
          onReset={resetFilters}
          filters={
            <>
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
                <SelectTrigger size="sm" className="h-8 w-[124px] text-xs" aria-label="按套餐状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="active">启用</SelectItem>
                  <SelectItem value="disabled">停用</SelectItem>
                  <SelectItem value="archived">已归档</SelectItem>
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
                <SelectTrigger size="sm" className="h-8 w-[164px] text-xs" aria-label="按产品筛选套餐">
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
              title="没有查看套餐的权限"
              description="需要 plan:read 权限，接口同样会拒绝这次请求。"
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
              caption="套餐列表"
              empty={
                <EmptyState
                  icon={<Package className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的套餐" : "还没有套餐"}
                  description={
                    chips.length > 0 ? "换一个关键词，或清空筛选重新查看。" : "创建套餐后，签发授权时可以一键套用标准周期与上限。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setFormOpen(true)}>
                        <Plus className="size-3.5" /> 新建套餐
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
        <PlanFormDialog
          open={editingId ? Boolean(detail.data) : formOpen}
          onOpenChange={(open) => {
            if (!open) {
              setFormOpen(false);
              setEditingId(null);
            }
          }}
          lookups={lookups.data ?? undefined}
          initial={editingId ? initial : null}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : "请稍后重试";
}

export default function PlansPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <PlansPageInner />
    </Suspense>
  );
}
