"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Laptop, RefreshCw, ShieldAlert, Wifi, X } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ActivationActions } from "@/components/licensing/activation-actions";
import { ActivationStatusBadge, ToneBadge } from "@/components/app/status-badge";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { buildQuery } from "@/lib/client/api";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import type { Lookups } from "@/lib/types";
import {
  ACTIVATION_STATUSES,
  ACTIVATION_STATUS_LABEL,
  maskIp,
  platformLabel,
  PLATFORM_OPTIONS,
  type DeviceActivationRow,
  type DevicesResponse,
} from "@/components/devices/device-shared";
import { cn } from "@/lib/utils";

function DevicesPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { session, hasPermission } = useSession();

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const platform = params.get("platform") ?? "";
  const status = params.get("status") ?? "";
  const online = params.get("online") === "1";
  const productId = params.get("productId") ?? "";
  const licenseId = params.get("licenseId") ?? "";
  const sort = params.get("sort");
  const order = (params.get("order") === "asc" ? "asc" : "desc") as "asc" | "desc";

  const [search, setSearch] = useState(q);

  const query = buildQuery({
    page,
    pageSize,
    q,
    platform,
    status,
    online: online ? "1" : undefined,
    productId,
    licenseId,
    sort,
    order,
  });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<DevicesResponse>(
    `/api/v1/admin/devices${query}`,
  );
  const lookups = useResource<Lookups>("/api/v1/admin/lookups");

  const timezone = session?.organization.timezone;
  /** IP / 指纹属于敏感字段：需要 activation:read，并且只有所有者与管理员能看到明文。 */
  const canViewSensitive =
    hasPermission("activation:read") && (session?.role.code === "owner" || session?.role.code === "admin");

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const searchString = next.toString();
    router.replace(searchString ? `${pathname}?${searchString}` : pathname, { scroll: false });
  };

  const goToPage = (nextPage: number) => updateParams((next) => next.set("page", String(nextPage)));

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
        updateParams((next) => {
          next.delete("q");
          next.set("page", "1");
        });
      },
    });
  }
  if (platform) {
    chips.push({
      label: "平台",
      value: platformLabel(platform),
      onRemove: () => updateParams((next) => {
        next.delete("platform");
        next.set("page", "1");
      }),
    });
  }
  if (status) {
    chips.push({
      label: "状态",
      value: ACTIVATION_STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => {
        next.delete("status");
        next.set("page", "1");
      }),
    });
  }
  if (online) {
    chips.push({
      label: "在线",
      value: "30 分钟内有心跳",
      onRemove: () => updateParams((next) => {
        next.delete("online");
        next.set("page", "1");
      }),
    });
  }
  if (productId) {
    const product = lookups.data?.products.find((item) => item.id === productId);
    chips.push({
      label: "产品",
      value: product?.name ?? productId,
      onRemove: () => updateParams((next) => {
        next.delete("productId");
        next.set("page", "1");
      }),
    });
  }
  if (licenseId) {
    chips.push({
      label: "所属授权",
      value: licenseId.slice(0, 8),
      onRemove: () => updateParams((next) => {
        next.delete("licenseId");
        next.set("page", "1");
      }),
    });
  }

  const summary = data?.summary;
  const summaryCards = [
    { key: "active", label: "绑定中", value: summary?.byStatus.active ?? 0, hint: "含已超过 30 分钟无心跳的设备" },
    { key: "online", label: "在线（30 分钟）", value: summary?.online ?? 0, hint: "最近 30 分钟内有心跳" },
    { key: "released", label: "已解绑", value: summary?.byStatus.released ?? 0, hint: "名额已释放，记录保留" },
    { key: "blocked", label: "已禁用", value: summary?.byStatus.blocked ?? 0, hint: "可随时恢复" },
    { key: "revoked", label: "已撤销", value: summary?.byStatus.revoked ?? 0, hint: "随授权撤销产生，终态" },
  ];

  const columns: DataColumn<DeviceActivationRow>[] = [
    {
      key: "device",
      header: "设备名",
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <Laptop className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.device.name ?? "未命名设备"}</p>
            <p className="truncate text-[11px] text-muted-foreground">{row.product.name}</p>
          </div>
        </div>
      ),
      width: "200px",
    },
    {
      key: "platform",
      header: "平台",
      cell: (row) => (
        <span className="text-xs text-muted-foreground">{platformLabel(row.device.platform)}</span>
      ),
      width: "100px",
    },
    {
      key: "instance",
      header: "实例 ID",
      cell: (row) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-[150px] truncate font-mono text-[11px] text-muted-foreground">
              {row.device.instanceId}
            </span>
          </TooltipTrigger>
          <TooltipContent>{row.device.instanceId}</TooltipContent>
        </Tooltip>
      ),
      width: "160px",
    },
    {
      key: "license",
      header: "所属授权",
      cell: (row) => (
        <div className="min-w-0 space-y-0.5">
          <Link
            href={`/app/licenses/${row.license.id}`}
            onClick={(event) => event.stopPropagation()}
            className="block max-w-[150px] truncate font-mono text-[11px] text-primary hover:underline"
          >
            {row.license.id.slice(0, 8)}
          </Link>
          <p className="text-[11px] text-muted-foreground">
            授权状态 {ACTIVATION_STATUS_LABEL[row.license.adminStatus] ?? row.license.adminStatus}
          </p>
        </div>
      ),
      width: "160px",
    },
    {
      key: "customer",
      header: "客户",
      cell: (row) => (
        <Link
          href={`/app/licenses/${row.license.id}`}
          onClick={(event) => event.stopPropagation()}
          className="block max-w-[150px] truncate text-xs text-foreground hover:underline"
        >
          {row.license.customerName}
        </Link>
      ),
      width: "150px",
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => <ActivationStatusBadge status={row.status} />,
      width: "110px",
    },
    {
      key: "activated",
      header: "绑定时间",
      sortKey: "activated_at",
      cell: (row) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] text-muted-foreground">{formatRelative(row.activatedAt)}</span>
          </TooltipTrigger>
          <TooltipContent>{formatDateTime(row.activatedAt, timezone)}</TooltipContent>
        </Tooltip>
      ),
      width: "110px",
    },
    {
      key: "lastSeen",
      header: "最后在线",
      sortKey: "last_seen_at",
      cell: (row) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  row.online ? "bg-success" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              {formatRelative(row.lastSeenAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>{formatDateTime(row.lastSeenAt, timezone)}</p>
            <p className="text-muted-foreground">
              {row.online ? "最近 30 分钟内有心跳" : "最近 30 分钟无心跳"}；最后在线 ≠ 当前在线
            </p>
          </TooltipContent>
        </Tooltip>
      ),
      width: "120px",
    },
    {
      key: "ip",
      header: "IP",
      cell: (row) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {canViewSensitive ? (row.lastIp ?? "—") : maskIp(row.lastIp)}
        </span>
      ),
      width: "130px",
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "60px",
      cell: (row) => (
        <div onClick={(event) => event.stopPropagation()}>
          <ActivationActions
            activation={{ id: row.id, status: row.status, deviceName: row.device.name }}
            onChanged={refresh}
            compact
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title="激活设备"
        description="跨授权查看所有激活记录（绑定行为），不是设备档案：同一台设备解绑后重新激活会生成新的记录。「在线」只表示最近 30 分钟内有心跳，最后在线 ≠ 当前在线。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              当前筛选命中 <span className="tabular font-medium text-foreground">{formatNumber(data.total)}</span> 条激活记录
            </span>
          ) : null
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/licenses">去授权管理</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={isLoading || isRefreshing}>
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {summaryCards.map((card) => (
          <div key={card.key} className="rounded-xl border border-border bg-card p-3 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{card.label}</span>
              <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {card.key === "online" ? <Wifi className="size-3.5" /> : <Laptop className="size-3.5" />}
              </span>
            </div>
            <p className="tabular mt-1.5 text-lg font-semibold text-foreground">
              {summary ? formatNumber(card.value) : "—"}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{card.hint}</p>
          </div>
        ))}
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">
        统计范围为组织内全部激活记录，不受上方筛选条件影响。
      </p>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <FilterBar
          searchValue={search}
          onSearchChange={setSearch}
          onSearchSubmit={() =>
            updateParams((next) => {
              next.set("q", search);
              next.set("page", "1");
            })
          }
          searchPlaceholder="搜索设备名、实例 ID、客户名或邮箱…"
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
                <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按产品筛选">
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
                value={platform || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("platform");
                    else next.set("platform", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[132px] text-xs" aria-label="按平台筛选">
                  <SelectValue placeholder="全部平台" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部平台</SelectItem>
                  {PLATFORM_OPTIONS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {platformLabel(item)}
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
                <SelectTrigger size="sm" className="h-8 w-[124px] text-xs" aria-label="按状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {ACTIVATION_STATUSES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {ACTIVATION_STATUS_LABEL[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={online ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={online}
                    onClick={() =>
                      updateParams((next) => {
                        if (online) next.delete("online");
                        else next.set("online", "1");
                        next.set("page", "1");
                      })
                    }
                  >
                    <Wifi className="size-3.5" /> 30 分钟内有心跳
                  </Button>
                </TooltipTrigger>
                <TooltipContent>只看最近 30 分钟内有心跳的绑定中设备（在线 ≠ 正在使用）</TooltipContent>
              </Tooltip>
            </>
          }
        />

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
              sort={sort ? { key: sort, order } : null}
              onSortChange={(key, nextOrder) =>
                updateParams((next) => {
                  next.set("sort", key);
                  next.set("order", nextOrder);
                  next.set("page", "1");
                })
              }
              onRowClick={(row) => router.push(`/app/devices/${row.device.id}`)}
              caption="激活设备列表"
              empty={
                <EmptyState
                  icon={<Laptop className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的设备" : "还没有任何设备激活"}
                  description={
                    chips.length > 0
                      ? "尝试放宽筛选条件，或清空筛选后重新查看；「在线」只看最近 30 分钟内有心跳的设备。"
                      : "设备在客户端完成激活后才会出现在这里。可以先签发授权，再让客户用兑换码激活。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : (
                      <Button size="sm" asChild>
                        <Link href="/app/licenses">去签发授权</Link>
                      </Button>
                    )
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
                unit="条激活记录"
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

      <div className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          解绑只释放设备名额，默认不返还累计激活次数；禁用设备不释放名额但会阻止校验。IP 与设备指纹属于敏感字段，
          仅所有者/管理员可见明文{canViewSensitive ? "" : "（当前角色已脱敏）"}。
        </p>
        {!canViewSensitive ? <ToneBadge tone="neutral">敏感字段已脱敏</ToneBadge> : null}
      </div>
    </div>
  );
}

export default function DevicesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <DevicesPageInner />
    </Suspense>
  );
}
