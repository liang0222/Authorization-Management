"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Boxes, ExternalLink, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import {
  CreateProductDialog,
  PRODUCT_STATUS_LABEL,
  PRODUCT_TYPE_LABEL,
  PRODUCT_TYPE_OPTIONS,
} from "@/components/catalog/product-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { buildQuery } from "@/lib/client/api";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import type { PageResult, ProductRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, Tone> = {
  active: "success",
  disabled: "warning",
  archived: "neutral",
};

const STATUS_OPTIONS = ["active", "disabled", "archived"] as const;

function ProductsPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, status: sessionStatus } = useSession();

  const canRead = hasPermission("product:read");
  const canWrite = hasPermission("product:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 12) || 12;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const productType = params.get("productType") ?? "";
  const sort = params.get("sort") ?? "";
  const order = (params.get("order") ?? "desc") as "asc" | "desc";

  const [search, setSearch] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);

  const query = buildQuery({ page, pageSize, q, status, productType, sort, order });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<ProductRow>>(
    canRead ? `/api/v1/admin/products${query}` : null,
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
      value: PRODUCT_STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }
  if (productType) {
    chips.push({
      label: "类型",
      value: PRODUCT_TYPE_LABEL[productType] ?? productType,
      onRemove: () => updateParams((next) => next.delete("productType")),
    });
  }

  const totals = useMemo(() => {
    const items = data?.items ?? [];
    return items.reduce(
      (acc, row) => ({
        licenses: acc.licenses + row.counts.licenses,
        devices: acc.devices + row.counts.activeDevices,
        features: acc.features + row.counts.features,
      }),
      { licenses: 0, devices: 0, features: 0 },
    );
  }, [data]);

  const columns: DataColumn<ProductRow>[] = useMemo(
    () => [
      {
        key: "name",
        header: "产品",
        sortKey: "name",
        cell: (row) => (
          <div className="min-w-0">
            <Link
              href={`/app/products/${row.id}`}
              className="truncate text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              {row.name}
            </Link>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{row.code}</p>
          </div>
        ),
        width: "220px",
      },
      {
        key: "type",
        header: "类型",
        cell: (row) => (
          <span className="text-xs text-muted-foreground">{PRODUCT_TYPE_LABEL[row.type] ?? row.type}</span>
        ),
        width: "110px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={STATUS_TONE[row.status] ?? "neutral"}>
            {PRODUCT_STATUS_LABEL[row.status] ?? row.status}
          </ToneBadge>
        ),
        width: "92px",
      },
      {
        key: "version",
        header: "当前版本",
        cell: (row) =>
          row.currentVersion ? (
            <span className="font-mono text-xs text-foreground">{row.currentVersion}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">未标注</span>
          ),
        width: "92px",
      },
      {
        key: "counts",
        header: "配置对象",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-wrap items-center gap-1">
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  功能 {row.counts.features}
                </ToneBadge>
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  套餐 {row.counts.plans}
                </ToneBadge>
                <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                  凭证 {row.counts.credentials}
                </ToneBadge>
              </div>
            </TooltipTrigger>
            <TooltipContent>功能权限定义、授权套餐与 API 凭证都归属这个产品。</TooltipContent>
          </Tooltip>
        ),
        width: "220px",
      },
      {
        key: "licenses",
        header: "授权 / 活跃设备",
        align: "right",
        cell: (row) => (
          <div className="tabular text-right text-xs">
            <span className="font-medium text-foreground">{formatNumber(row.counts.licenses)}</span>
            <span className="text-muted-foreground"> / {formatNumber(row.counts.activeDevices)}</span>
          </div>
        ),
        width: "130px",
      },
      {
        key: "createdAt",
        header: "创建时间",
        sortKey: "created_at",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[11px] text-muted-foreground">{formatRelative(row.createdAt)}</span>
            </TooltipTrigger>
            <TooltipContent>{formatDateTime(row.createdAt)}</TooltipContent>
          </Tooltip>
        ),
        width: "110px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/app/products/${row.id}`}>
              进入 <ExternalLink className="size-3" />
            </Link>
          </Button>
        ),
        width: "90px",
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "业务管理" }, { label: "软件产品" }]}
        title="软件产品"
        description="每个产品是一套独立的授权体系：自己的套餐、功能权限、API 凭证与签名密钥。产品停用后，所有校验请求立即返回 403。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              本页 <span className="tabular font-medium text-foreground">{data.items.length}</span> 个产品 · 授权{" "}
              <span className="tabular text-foreground">{formatNumber(totals.licenses)}</span> · 活跃设备{" "}
              <span className="tabular text-foreground">{formatNumber(totals.devices)}</span>
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
                <Plus className="size-3.5" /> 新建产品
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="size-3.5" /> 新建产品
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>当前角色没有 product:write 权限</TooltipContent>
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
          searchPlaceholder="按产品名称或编码搜索…"
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
                <SelectTrigger size="sm" className="h-8 w-[128px] text-xs" aria-label="按产品状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {PRODUCT_STATUS_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={productType || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("productType");
                    else next.set("productType", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[140px] text-xs" aria-label="按产品类型筛选">
                  <SelectValue placeholder="全部类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  {PRODUCT_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
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
              title="没有查看产品的权限"
              description="需要 product:read 权限。隐藏导航只是界面行为，接口同样会拒绝请求。"
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
              // 与授权/设备列表保持一致：整行可点进详情，不必瞄准「进入」按钮。
              onRowClick={(row) => router.push(`/app/products/${row.id}`)}
              loading={isLoading || isRefreshing}
              sort={{ key: sort, order }}
              onSortChange={(key, nextOrder) =>
                updateParams((params_) => {
                  params_.set("sort", key);
                  params_.set("order", nextOrder);
                  params_.set("page", "1");
                })
              }
              caption="软件产品列表"
              empty={
                <EmptyState
                  icon={<Boxes className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的产品" : "还没有软件产品"}
                  description={
                    chips.length > 0
                      ? "换一个关键词，或清空筛选重新查看。"
                      : "先创建产品，才能签发授权、定义功能权限并接入客户端校验。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="size-3.5" /> 新建产品
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
        <CreateProductDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) => router.push(`/app/products/${id}`)}
        />
      ) : null}
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <ProductsPageInner />
    </Suspense>
  );
}
