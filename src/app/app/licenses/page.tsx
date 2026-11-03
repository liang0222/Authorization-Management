"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Filter, KeyRound, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, SelectionBar, type FilterChip } from "@/components/app/filter-bar";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { EffectiveStatusBadge } from "@/components/app/status-badge";
import { LicenseIssueDrawer } from "@/components/licensing/license-issue-drawer";
import { LicenseBatchDialog } from "@/components/licensing/license-dialogs";
import { LicenseRowActions } from "@/components/licensing/license-row-actions";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery, errorMessage } from "@/lib/client/api";
import { durationLabel, formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { ADMIN_STATUS_LABEL, EFFECTIVE_STATUS_LABEL, type EffectiveStatus, type LicenseAdminStatus } from "@/lib/domain/effective-status";
import type { LicenseRow, Lookups, PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const ADMIN_STATUSES: LicenseAdminStatus[] = ["draft", "pending", "active", "suspended", "revoked", "cancelled"];
function LicensesPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission } = useSession();

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const sort = params.get("sort");
  const order = (params.get("order") === "asc" ? "asc" : "desc") as "asc" | "desc";
  const productId = params.get("productId") ?? "";
  const effectiveStatus = params.get("effectiveStatus") ?? "";
  const adminStatuses = params.getAll("adminStatus");
  const expiringInDays = params.get("expiringInDays") ?? "";

  const [search, setSearch] = useState(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [issueOpen, setIssueOpen] = useState(params.get("action") === "issue");
  const [batchOpen, setBatchOpen] = useState(params.get("action") === "batch");
  const [batchSuspendOpen, setBatchSuspendOpen] = useState(false);
  const [reason, setReason] = useState("");

  const query = buildQuery({
    page,
    pageSize,
    q,
    sort,
    order,
    productId,
    effectiveStatus,
    adminStatus: adminStatuses,
    expiringInDays,
  });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<LicenseRow>>(
    `/api/v1/admin/licenses${query}`,
  );
  const lookups = useResource<Lookups>("/api/v1/admin/lookups");

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const searchString = next.toString();
    router.replace(searchString ? `${pathname}?${searchString}` : pathname, { scroll: false });
  };

  const goToPage = (nextPage: number) => {
    updateParams((next) => {
      next.set("page", String(nextPage));
    });
  };

  const resetFilters = () => {
    setSearch("");
    router.replace(pathname, { scroll: false });
  };

  const chips: FilterChip[] = [];
  if (q) chips.push({ label: "搜索", value: q, onRemove: () => { setSearch(""); updateParams((next) => next.delete("q")); } });
  if (productId) {
    const product = lookups.data?.products.find((item) => item.id === productId);
    chips.push({
      label: "产品",
      value: product?.name ?? productId,
      onRemove: () => updateParams((next) => next.delete("productId")),
    });
  }
  if (effectiveStatus) {
    chips.push({
      label: "有效状态",
      value: EFFECTIVE_STATUS_LABEL[effectiveStatus as EffectiveStatus] ?? effectiveStatus,
      onRemove: () => updateParams((next) => next.delete("effectiveStatus")),
    });
  }
  adminStatuses.forEach((status) =>
    chips.push({
      label: "管理状态",
      value: ADMIN_STATUS_LABEL[status as LicenseAdminStatus] ?? status,
      onRemove: () =>
        updateParams((next) => {
          const remaining = adminStatuses.filter((item) => item !== status);
          next.delete("adminStatus");
          remaining.forEach((item) => next.append("adminStatus", item));
        }),
    }),
  );
  if (expiringInDays) {
    chips.push({
      label: "到期窗口",
      value: `${expiringInDays} 天内到期`,
      onRemove: () => updateParams((next) => next.delete("expiringInDays")),
    });
  }

  const columns: DataColumn<LicenseRow>[] = useMemo(
    () => [
      {
        key: "customer",
        header: "客户 / 产品",
        cell: (row) => (
          // max-w 必须给死，否则表格 auto 布局会按最长内容（产品编码）撑开，
          // 把状态列整列挤出小屏可视区。
          <div className="min-w-0 max-w-[160px] sm:max-w-[220px]">
            <p className="truncate text-sm font-medium text-foreground">{row.customer.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.product.name}
              <span className="ml-1 font-mono text-[10px]">{row.product.code}</span>
            </p>
          </div>
        ),
        width: "150px",
        className: "min-w-[150px] sm:min-w-[200px]",
      },
      {
        key: "duration",
        header: "周期",
        cell: (row) => (
          <div className="space-y-0.5">
            <p className="text-xs text-foreground">{durationLabel(row.duration)}</p>
            <p className="text-[11px] text-muted-foreground">{row.timezone}</p>
          </div>
        ),
        width: "140px",
        // 小屏优先保留客户/产品、到期、状态、操作；周期与兑换码在平板上再出现。
        className: "hidden md:table-cell",
        headerClassName: "hidden md:table-cell",
      },
      {
        key: "window",
        header: "开始 / 到期",
        sortKey: "expires_at",
        cell: (row) => {
          // 未激活的按次授权还没有 expires_at，展示「激活后 N 天」比「永久有效」准确，
          // 否则 30 天授权会被误读成永久授权。
          const pending = !row.expiresAt && row.duration.unit !== "lifetime";
          return (
            <div className="space-y-0.5 text-[11px]">
              <p className="text-muted-foreground">
                开始 {row.startsAt ? formatDate(row.startsAt) : "首次激活"}
              </p>
              <p className={cn("tabular", row.expiresAt ? "text-foreground" : "text-muted-foreground")}>
                {row.expiresAt
                  ? `到期 ${formatDate(row.expiresAt)}`
                  : pending
                    ? `激活后 ${durationLabel(row.duration)}`
                    : "永久有效"}
              </p>
            </div>
          );
        },
        width: "120px",
        className: "min-w-[120px] sm:min-w-[170px]",
      },
      {
        key: "devices",
        header: "设备",
        sortKey: "max_devices",
        align: "right",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="inline-flex flex-col items-end gap-1">
                <span className="tabular text-xs text-foreground">
                  {row.activeDevices} / {row.maxDevices}
                </span>
                <span className="h-1 w-14 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      row.activeDevices >= row.maxDevices ? "bg-warning" : "bg-primary/70",
                    )}
                    style={{ width: `${Math.min(100, (row.activeDevices / Math.max(1, row.maxDevices)) * 100)}%` }}
                  />
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              活跃设备 {row.activeDevices} 台，上限 {row.maxDevices} 台；累计激活 {row.activationCount} 次
              {row.maxActivationCount ? `（上限 ${row.maxActivationCount}）` : ""}
            </TooltipContent>
          </Tooltip>
        ),
        width: "90px",
        className: "hidden sm:table-cell",
        headerClassName: "hidden sm:table-cell",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <div className="flex flex-col items-start gap-1">
            <EffectiveStatusBadge status={row.effective.status} />
            <span className="text-[11px] text-muted-foreground">
              管理：{ADMIN_STATUS_LABEL[row.adminStatus]}
            </span>
          </div>
        ),
        width: "130px",
      },
      {
        key: "key",
        header: "兑换码",
        cell: (row) =>
          row.keyMask ? (
            <span className="font-mono text-[11px] text-muted-foreground">{row.keyMask}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">未生成</span>
          ),
        width: "150px",
        className: "hidden lg:table-cell",
        headerClassName: "hidden lg:table-cell",
      },
      {
        key: "created",
        header: "创建时间",
        sortKey: "created_at",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[11px] text-muted-foreground">{formatRelative(row.createdAt)}</span>
            </TooltipTrigger>
            <TooltipContent>{formatDateTime(row.createdAt, row.timezone)}</TooltipContent>
          </Tooltip>
        ),
        width: "110px",
        className: "hidden lg:table-cell",
        headerClassName: "hidden lg:table-cell",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => <LicenseRowActions license={row} onChanged={refresh} />,
        width: "80px",
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const batchSuspend = async () => {
    const ids = Array.from(selected);
    const results = await Promise.allSettled(
      ids.map((id) => apiRequest(`/api/v1/admin/licenses/${id}/suspend`, { method: "POST", body: { reason } })),
    );
    const ok = results.filter((item) => item.status === "fulfilled").length;
    const failed = results.length - ok;
    if (failed === 0) toast.success(`已暂停 ${ok} 份授权`);
    else toast.error(`成功 ${ok} 份，失败 ${failed} 份：${errorMessage((results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason)}`);
    setSelected(new Set());
    refresh();
  };

  const exportUrl = `/api/v1/admin/licenses/export${query}`;

  return (
    <div className="space-y-3">
      <PageHeader
        title="授权管理"
        description="一份授权可以绑定多台设备；管理状态（暂停/撤销）与实际有效状态分开计算。兑换码默认脱敏，明文只在签发时出现一次。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 份授权符合当前条件
            </span>
          ) : null
        }
        actions={
          <>
            {hasPermission("license:read") ? (
              <Button variant="outline" size="sm" asChild>
                <a href={exportUrl} download>
                  <Download className="size-3.5" /> 导出 CSV
                </a>
              </Button>
            ) : null}
            {hasPermission("license:issue") ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setBatchOpen(true)}>
                  <KeyRound className="size-3.5" /> 批量生成
                </Button>
                <Button size="sm" onClick={() => setIssueOpen(true)}>
                  <Plus className="size-3.5" /> 签发授权
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <FilterBar
          searchValue={search}
          onSearchChange={setSearch}
          onSearchSubmit={() => updateParams((next) => { next.set("q", search); next.set("page", "1"); })}
          searchPlaceholder="搜索客户、产品、订单号或兑换码后 4 位…"
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
                <SelectTrigger size="sm" className="h-8 w-[168px] text-xs" aria-label="按产品筛选">
                  <SelectValue placeholder="全部产品" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部产品</SelectItem>
                  {lookups.data?.products.map((product) => (
                    <SelectItem key={product.id} value={product.id}>
                      {product.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={effectiveStatus || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("effectiveStatus");
                    else next.set("effectiveStatus", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[148px] text-xs" aria-label="按有效状态筛选">
                  <SelectValue placeholder="全部有效状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部有效状态</SelectItem>
                  {(Object.keys(EFFECTIVE_STATUS_LABEL) as EffectiveStatus[]).map((status) => (
                    <SelectItem key={status} value={status}>
                      {EFFECTIVE_STATUS_LABEL[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                    <Filter className="size-3.5" />
                    管理状态
                    {adminStatuses.length > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                        {adminStatuses.length}
                      </span>
                    ) : null}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    多选，立即生效
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {ADMIN_STATUSES.map((status) => (
                    <DropdownMenuCheckboxItem
                      key={status}
                      checked={adminStatuses.includes(status)}
                      onCheckedChange={(checked) =>
                        updateParams((next) => {
                          const remaining = adminStatuses.filter((item) => item !== status);
                          next.delete("adminStatus");
                          const final = checked ? [...remaining, status] : remaining;
                          final.forEach((item) => next.append("adminStatus", item));
                          next.set("page", "1");
                        })
                      }
                    >
                      {ADMIN_STATUS_LABEL[status]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant={expiringInDays ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() =>
                  updateParams((next) => {
                    if (expiringInDays) next.delete("expiringInDays");
                    else next.set("expiringInDays", "30");
                    next.set("page", "1");
                  })
                }
              >
                30 天内到期
              </Button>
            </>
          }
          actions={
            <Button variant="ghost" size="sm" onClick={refresh} disabled={isRefreshing || isLoading}>
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
            </Button>
          }
        />

        <SelectionBar
          count={selected.size}
          scopeHint="仅当前页勾选；跨页不会保留"
          onClear={() => setSelected(new Set())}
        >
          {hasPermission("license:suspend") ? (
            <Button size="xs" variant="outline" onClick={() => setBatchSuspendOpen(true)}>
              批量暂停
            </Button>
          ) : null}
        </SelectionBar>

        {error ? (
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
              selectable={hasPermission("license:suspend")}
              selected={selected}
              onSelectedChange={setSelected}
              sort={sort ? { key: sort, order } : null}
              onSortChange={(key, nextOrder) =>
                updateParams((next) => {
                  next.set("sort", key);
                  next.set("order", nextOrder);
                  next.set("page", "1");
                })
              }
              onRowClick={(row) => router.push(`/app/licenses/${row.id}`)}
              caption="授权列表"
              empty={
                <EmptyState
                  icon={<KeyRound className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的授权" : "还没有签发任何授权"}
                  description={
                    chips.length > 0
                      ? "尝试放宽筛选条件，或清空筛选后重新查看。"
                      : "签发第一份授权后，客户即可使用兑换码在客户端激活。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : hasPermission("license:issue") ? (
                      <Button size="sm" onClick={() => setIssueOpen(true)}>
                        <Plus className="size-3.5" /> 签发第一份授权
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
                onPageChange={goToPage}
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

      {hasPermission("license:read") && data && data.items.some((row) => !row.effective.canActivate) ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p>
            列表中「设备名额已满」或「累计激活次数用尽」只影响 <span className="font-medium text-foreground">新激活</span>，
            已绑定设备仍可在有效期内继续使用；如需释放名额，请到设备页解绑或使用「重置激活次数」。
          </p>
        </div>
      ) : null}

      <LicenseIssueDrawer open={issueOpen} onOpenChange={setIssueOpen} onIssued={refresh} />
      <LicenseBatchDialog open={batchOpen} onOpenChange={setBatchOpen} onIssued={refresh} />

      <ConfirmDialog
        open={batchSuspendOpen}
        onOpenChange={setBatchSuspendOpen}
        title={`批量暂停 ${selected.size} 份授权`}
        description="暂停后这些授权的所有设备将在下一次在线校验时被拒绝。操作会逐条写入审计日志。"
        confirmLabel="批量暂停"
        tone="default"
        onConfirm={async () => {
          await batchSuspend();
        }}
      >
        <p className="text-xs text-muted-foreground">批量操作不校验跨页选择：仅影响当前页勾选的授权。</p>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="暂停原因（可选）" />
      </ConfirmDialog>
    </div>
  );
}

export default function LicensesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <LicensesPageInner />
    </Suspense>
  );
}
