"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, RefreshCw, ShieldAlert, Ticket, UserRound, X } from "lucide-react";
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
import { CreateCustomerDialog, EditCustomerDialog, type CustomerDetail } from "@/components/catalog/customer-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery, errorMessage } from "@/lib/client/api";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import type { CustomerRow, PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = { active: "正常", disabled: "已停用" };
const STATUS_TONE: Record<string, Tone> = { active: "success", disabled: "warning" };

function CustomersPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, status: sessionStatus } = useSession();

  const canRead = hasPermission("customer:read");
  const canWrite = hasPermission("customer:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const sort = params.get("sort") ?? "";
  const order = (params.get("order") ?? "desc") as "asc" | "desc";

  const [search, setSearch] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const query = buildQuery({ page, pageSize, q, status, sort, order });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<CustomerRow>>(
    canRead ? `/api/v1/admin/customers${query}` : null,
  );
  const editing = useResource<{ customer: CustomerDetail }>(
    canRead && editingId ? `/api/v1/admin/customers/${editingId}` : null,
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

  const toggleStatus = async (row: CustomerRow) => {
    const nextStatus = row.status === "active" ? "disabled" : "active";
    try {
      await apiRequest(`/api/v1/admin/customers/${row.id}`, {
        method: "PATCH",
        body: { status: nextStatus },
      });
      toast.success(nextStatus === "active" ? "客户已启用" : "客户已停用", {
        description:
          nextStatus === "active" ? "该客户名下授权恢复正常校验。" : "已签发授权仍可校验，但新授权签发需先启用客户。",
      });
      refresh();
    } catch (err) {
      toast.error("状态切换失败", { description: errorMessage(err) });
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
    chips.push({
      label: "状态",
      value: STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<CustomerRow>[] = useMemo(
    () => [
      {
        key: "name",
        header: "客户",
        sortKey: "name",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {row.companyName ?? "未填写公司主体"}
            </p>
          </div>
        ),
        width: "200px",
      },
      {
        key: "customerCode",
        header: "客户编号",
        cell: (row) =>
          row.customerCode ? (
            <span className="font-mono text-[11px] text-muted-foreground">{row.customerCode}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          ),
        width: "130px",
      },
      {
        key: "contact",
        header: "联系方式",
        cell: (row) => (
          <div className="min-w-0 space-y-0.5 text-[11px]">
            <p className="truncate text-foreground">{row.email ?? "未填写邮箱"}</p>
            <p className="truncate text-muted-foreground">{row.phone ?? "未填写电话"}</p>
          </div>
        ),
        width: "180px",
      },
      {
        key: "licenses",
        header: "授权",
        align: "right",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="tabular text-right text-xs">
                <span className="font-medium text-foreground">{formatNumber(row.counts.licenses)}</span>
                <span className="text-muted-foreground"> 份</span>
                <p className="text-[10px] text-muted-foreground">生效 {formatNumber(row.counts.activeLicenses)}</p>
              </div>
            </TooltipTrigger>
            <TooltipContent>点击行末菜单可跳转到该客户的授权列表。</TooltipContent>
          </Tooltip>
        ),
        width: "90px",
      },
      {
        key: "identities",
        header: "第三方身份",
        align: "right",
        cell: (row) => (
          <span className="tabular text-xs text-muted-foreground">{formatNumber(row.counts.identities)}</span>
        ),
        width: "100px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={STATUS_TONE[row.status] ?? "neutral"}>{STATUS_LABEL[row.status] ?? row.status}</ToneBadge>
        ),
        width: "90px",
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`客户 ${row.name} 的操作菜单`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem asChild>
                <Link href={`/app/licenses?customerId=${row.id}`}>
                  <Ticket className="size-3.5" /> 查看授权
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/app/customers/${row.id}`}>
                  <UserRound className="size-3.5" /> 客户档案
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/app/licenses?customerId=${row.id}&issue=1`}>
                  <Plus className="size-3.5" /> 签发授权
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {canWrite ? (
                <DropdownMenuItem onSelect={() => setEditingId(row.id)}>
                  <Pencil className="size-3.5" /> 编辑资料
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <DropdownMenuItem onSelect={() => toggleStatus(row)}>
                  <UserRound className="size-3.5" /> {row.status === "active" ? "停用客户" : "启用客户"}
                </DropdownMenuItem>
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
        breadcrumbs={[{ label: "业务管理" }, { label: "客户管理" }]}
        title="客户管理"
        description="客户是授权的持有方。停用客户只影响后续签发，已签发授权仍按自身状态校验。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 个客户
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
                <Plus className="size-3.5" /> 新建客户
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="size-3.5" /> 新建客户
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>当前角色没有 customer:write 权限</TooltipContent>
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
          searchPlaceholder="按客户名称、编号或邮箱搜索…"
          chips={chips}
          onReset={resetFilters}
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
              <SelectTrigger size="sm" className="h-8 w-[128px] text-xs" aria-label="按客户状态筛选">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">正常</SelectItem>
                <SelectItem value="disabled">已停用</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        {denied ? (
          <div className="p-4">
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title="没有查看客户的权限"
              description="需要 customer:read 权限，接口同样会拒绝这次请求。"
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
              // 与其他列表一致：整行可点进客户档案。
              onRowClick={(row) => router.push(`/app/customers/${row.id}`)}
              loading={isLoading || isRefreshing}
              sort={{ key: sort, order }}
              onSortChange={(key, nextOrder) =>
                updateParams((next) => {
                  next.set("sort", key);
                  next.set("order", nextOrder);
                  next.set("page", "1");
                })
              }
              caption="客户列表"
              empty={
                <EmptyState
                  icon={<UserRound className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的客户" : "还没有客户"}
                  description={
                    chips.length > 0 ? "换一个关键词，或清空筛选重新查看。" : "先创建客户，才能为其签发授权。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="size-3.5" /> 新建客户
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
          <CreateCustomerDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreated={() => {
              refresh();
            }}
          />
          {editing.data ? (
            <EditCustomerDialog
              open={Boolean(editingId)}
              onOpenChange={(open) => {
                if (!open) setEditingId(null);
              }}
              customer={editing.data.customer}
              onSaved={refresh}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function CustomersPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <CustomersPageInner />
    </Suspense>
  );
}
