"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, MoreHorizontal, Pencil, Plus, RefreshCw, ShieldAlert, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import {
  defaultValueToText,
  FEATURE_STATUS_LABEL,
  FeatureFormDialog,
  VALUE_TYPE_LABEL,
} from "@/components/catalog/feature-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery } from "@/lib/client/api";
import { formatNumber } from "@/lib/format";
import type { Lookups, PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FeatureListRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  valueType: string;
  defaultValue: unknown;
  status: string;
  product: { id: string; name: string; code: string };
  planCount: number;
  licenseCount: number;
  createdAt: string;
}

const STATUS_TONE: Record<string, Tone> = { active: "success", archived: "neutral" };

function FeaturesPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, status: sessionStatus } = useSession();

  const canRead = hasPermission("feature:read");
  const canWrite = hasPermission("feature:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const productId = params.get("productId") ?? "";
  const status = params.get("status") ?? "";

  const [search, setSearch] = useState(q);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FeatureListRow | null>(null);
  const [archiving, setArchiving] = useState<FeatureListRow | null>(null);

  const query = buildQuery({ page, pageSize, q, productId, status });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<FeatureListRow>>(
    canRead ? `/api/v1/admin/features${query}` : null,
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

  const archive = async (row: FeatureListRow) => {
    await apiRequest(`/api/v1/admin/features/${row.id}`, { method: "DELETE" });
    toast.success("功能权限已归档", {
      description: "归档后新签发的授权不再包含这个功能，已签发的保持原快照。",
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
      value: FEATURE_STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<FeatureListRow>[] = useMemo(
    () => [
      {
        key: "name",
        header: "功能",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{row.code}</p>
          </div>
        ),
        width: "200px",
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
        width: "140px",
      },
      {
        key: "valueType",
        header: "取值类型",
        cell: (row) => (
          <ToneBadge tone="neutral" dot={false}>
            {VALUE_TYPE_LABEL[row.valueType] ?? row.valueType}
          </ToneBadge>
        ),
        width: "130px",
      },
      {
        key: "defaultValue",
        header: "默认值",
        cell: (row) => (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {defaultValueToText(row.defaultValue) || "—"}
          </code>
        ),
        width: "120px",
      },
      {
        key: "usage",
        header: "引用情况",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  套餐 {row.planCount}
                </ToneBadge>
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  授权 {formatNumber(row.licenseCount)}
                </ToneBadge>
              </div>
            </TooltipTrigger>
            <TooltipContent>被套餐或授权引用的功能不能归档，接口返回 409。</TooltipContent>
          </Tooltip>
        ),
        width: "170px",
      },
      {
        key: "description",
        header: "说明",
        cell: (row) => (
          <span className="line-clamp-2 text-[11px] text-muted-foreground">{row.description ?? "—"}</span>
        ),
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={STATUS_TONE[row.status] ?? "neutral"}>
            {FEATURE_STATUS_LABEL[row.status] ?? row.status}
          </ToneBadge>
        ),
        width: "90px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) =>
          canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={`功能 ${row.name} 的操作菜单`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onSelect={() => setEditing(row)}>
                  <Pencil className="size-3.5" /> 编辑
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setArchiving(row)}
                  disabled={row.status === "archived"}
                  variant="destructive"
                >
                  <Archive className="size-3.5" /> 归档
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
        width: "60px",
      },
    ],
    [canWrite],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "业务管理" }, { label: "功能权限" }]}
        title="功能权限"
        description="功能权限是授权里的开关与参数：套餐给默认值，单份授权还可以覆盖。被引用的功能无法归档，避免客户端读到空权限。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              跨产品共 <span className="tabular font-medium text-foreground">{data.total}</span> 个功能定义
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
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-3.5" /> 添加功能
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
          searchPlaceholder="按功能名称或编码搜索…"
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
                <SelectTrigger size="sm" className="h-8 w-[164px] text-xs" aria-label="按产品筛选功能">
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
                <SelectTrigger size="sm" className="h-8 w-[124px] text-xs" aria-label="按功能状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="active">生效中</SelectItem>
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
              title="没有查看功能权限的权限"
              description="需要 feature:read 权限，接口同样会拒绝这次请求。"
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
              caption="功能权限列表"
              empty={
                <EmptyState
                  icon={<SlidersHorizontal className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的功能" : "还没有功能权限"}
                  description={
                    chips.length > 0
                      ? "换一个关键词，或清空筛选重新查看。"
                      : "先在某个产品下定义功能，套餐才能引用它作为默认值。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setFormOpen(true)}>
                        <Plus className="size-3.5" /> 添加功能
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
          <FeatureFormDialog
            open={formOpen || Boolean(editing)}
            onOpenChange={(open) => {
              if (!open) {
                setFormOpen(false);
                setEditing(null);
              }
            }}
            products={(lookups.data?.products ?? []).map((product) => ({
              id: product.id,
              name: product.name,
              code: product.code,
            }))}
            initial={
              editing
                ? {
                    id: editing.id,
                    productId: editing.product.id,
                    code: editing.code,
                    name: editing.name,
                    description: editing.description,
                    valueType: editing.valueType,
                    defaultValue: editing.defaultValue,
                    status: editing.status,
                  }
                : null
            }
            onSaved={refresh}
          />

          <ConfirmDialog
            open={Boolean(archiving)}
            onOpenChange={(open) => {
              if (!open) setArchiving(null);
            }}
            title="归档这个功能权限？"
            description={
              archiving
                ? `${archiving.product.name} / ${archiving.name}（${archiving.code}）。若仍被套餐或授权引用，接口会返回 409 并阻止归档。`
                : ""
            }
            confirmLabel="归档"
            tone="danger"
            onConfirm={async () => {
              if (archiving) await archive(archiving);
              setArchiving(null);
            }}
          >
            <p className="text-xs text-muted-foreground">
              归档后新签发的授权不再包含这个功能；已签发授权的快照保持不变。
            </p>
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}

export default function FeaturesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <FeaturesPageInner />
    </Suspense>
  );
}
