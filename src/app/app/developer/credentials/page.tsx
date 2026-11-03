"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  KeyRound,
  MoreHorizontal,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import { CopyButton } from "@/components/app/copy-button";
import {
  CREDENTIAL_STATUS_LABEL,
  CREDENTIAL_TYPE_LABEL,
  CreateCredentialDialog,
  EditCredentialDialog,
  RotateCredentialDialog,
  type CredentialRow,
} from "@/components/developer/credential-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery, errorMessage } from "@/lib/client/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Lookups, PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, Tone> = { active: "success", disabled: "warning", archived: "neutral" };

function CredentialsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, session, status: sessionStatus } = useSession();

  const canRead = hasPermission("credential:read");
  const canWrite = hasPermission("credential:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const productId = params.get("productId") ?? "";
  const type = params.get("type") ?? "";
  const status = params.get("status") ?? "";

  const [search, setSearch] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CredentialRow | null>(null);
  const [rotating, setRotating] = useState<CredentialRow | null>(null);
  const [toggling, setToggling] = useState<CredentialRow | null>(null);
  const [archiving, setArchiving] = useState<CredentialRow | null>(null);

  const query = buildQuery({ page, pageSize, q, productId, type, status });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<CredentialRow>>(
    canRead ? `/api/v1/admin/credentials${query}` : null,
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

  const toggleStatus = async (row: CredentialRow) => {
    const action = row.status === "active" ? "disable" : "enable";
    await apiRequest(`/api/v1/admin/credentials/${row.id}`, { method: "PATCH", body: { action } });
    toast.success(action === "disable" ? "凭证已停用" : "凭证已启用", {
      description:
        action === "disable"
          ? "停用后该 client_id 的所有请求都会被拒绝（401），密钥保留可再次启用。"
          : "凭证恢复可用，调用方可以继续使用原 client_id。",
    });
    refresh();
  };

  const archive = async (row: CredentialRow) => {
    await apiRequest(`/api/v1/admin/credentials/${row.id}`, { method: "DELETE" });
    toast.success("凭证已归档", { description: "归档不可逆，client_id 不能再次启用。" });
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
  if (type) {
    chips.push({
      label: "类型",
      value: CREDENTIAL_TYPE_LABEL[type] ?? type,
      onRemove: () => updateParams((next) => next.delete("type")),
    });
  }
  if (status) {
    chips.push({
      label: "状态",
      value: CREDENTIAL_STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<CredentialRow>[] = useMemo(
    () => [
      {
        key: "name",
        header: "凭证",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
            <p className="mt-0.5 flex items-center gap-1">
              <span className="truncate font-mono text-[11px] text-muted-foreground">{row.clientId}</span>
              <CopyButton value={row.clientId} label="复制 client_id" tooltip="复制 client_id" />
            </p>
          </div>
        ),
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
        width: "130px",
      },
      {
        key: "type",
        header: "类型",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <ToneBadge tone={row.type === "confidential_server" ? "brand" : "neutral"} dot={false}>
                  {CREDENTIAL_TYPE_LABEL[row.type] ?? row.type}
                </ToneBadge>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {row.type === "confidential_server"
                ? "服务端凭证：用 client_secret 换取令牌，可轮换密钥。"
                : "公开客户端：无密钥，靠设备 Ed25519 签名鉴权，不能轮换。"}
            </TooltipContent>
          </Tooltip>
        ),
        width: "120px",
      },
      {
        key: "scopes",
        header: "授权范围",
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.scopes.slice(0, 3).map((scope) => (
              <span
                key={scope}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {scope}
              </span>
            ))}
            {row.scopes.length > 3 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                    +{row.scopes.length - 3}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[240px]">
                  {row.scopes.slice(3).map((scope) => (
                    <span key={scope} className="block font-mono text-[11px]">
                      {scope}
                    </span>
                  ))}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ),
      },
      {
        key: "lastUsedAt",
        header: "最近调用",
        cell: (row) => (
          <span className="text-[11px] text-muted-foreground">
            {row.lastUsedAt ? formatRelative(row.lastUsedAt) : "从未调用"}
          </span>
        ),
        width: "110px",
      },
      {
        key: "rotatedAt",
        header: "密钥轮换",
        cell: (row) =>
          row.type === "confidential_server" ? (
            <span className="text-[11px] text-muted-foreground">
              {row.rotatedAt ? formatDateTime(row.rotatedAt, session?.organization.timezone) : "未轮换过"}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">不适用</span>
          ),
        width: "150px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={STATUS_TONE[row.status] ?? "neutral"}>
            {CREDENTIAL_STATUS_LABEL[row.status] ?? row.status}
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`凭证 ${row.name} 的操作菜单`}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setEditing(row)} disabled={row.status === "archived"}>
                  <KeyRound className="size-3.5" /> 编辑名称与范围
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setRotating(row)}
                  disabled={row.type !== "confidential_server" || row.status === "archived"}
                >
                  <RotateCw className="size-3.5" /> 轮换密钥
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setToggling(row)}
                  disabled={row.status === "archived"}
                >
                  {row.status === "active" ? (
                    <>
                      <PowerOff className="size-3.5" /> 停用凭证
                    </>
                  ) : (
                    <>
                      <Power className="size-3.5" /> 启用凭证
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setArchiving(row)}
                  disabled={row.status === "archived"}
                  variant="destructive"
                >
                  <ShieldAlert className="size-3.5" /> 归档凭证
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
        width: "60px",
      },
    ],
    [canWrite, session?.organization.timezone],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "开发者中心" }, { label: "API 凭证" }]}
        title="API 凭证"
        description="客户端调用授权服务的身份。公开客户端靠设备签名鉴权；机密服务端用 client_secret。密钥只保存哈希，明文仅在创建与轮换时出现一次。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 条凭证
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
                <Plus className="size-3.5" /> 新建凭证
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="size-3.5" /> 新建凭证
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>当前角色没有 credential:write 权限</TooltipContent>
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
          searchPlaceholder="按凭证名称或 client_id 搜索…"
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
                <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按产品筛选凭证">
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
                value={type || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("type");
                    else next.set("type", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[130px] text-xs" aria-label="按凭证类型筛选">
                  <SelectValue placeholder="全部类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  <SelectItem value="public_client">公开客户端</SelectItem>
                  <SelectItem value="confidential_server">机密服务端</SelectItem>
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
                <SelectTrigger size="sm" className="h-8 w-[120px] text-xs" aria-label="按凭证状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="active">生效中</SelectItem>
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
              title="没有查看 API 凭证的权限"
              description="需要 credential:read 权限，接口同样会拒绝这次请求。"
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
              caption="API 凭证列表"
              empty={
                <EmptyState
                  icon={<KeyRound className="size-5" />}
                  title={chips.length > 0 ? "没有符合条件的凭证" : "还没有 API 凭证"}
                  description={
                    chips.length > 0
                      ? "换一个关键词、类型或状态，或清空筛选。"
                      : "客户端接入前需要一条凭证：桌面端用公开客户端，服务端用机密服务端。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="size-3.5" /> 新建凭证
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

      <p className="text-[11px] text-muted-foreground">
        安全约定：client_secret 明文只在创建与轮换响应里返回一次，服务端只存 sha256 哈希；日志与审计都不记录密钥。
      </p>

      {canWrite ? (
        <>
          <CreateCredentialDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            lookups={lookups.data ?? undefined}
            onCreated={refresh}
          />
          <EditCredentialDialog
            credential={editing}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            onSaved={refresh}
          />
          <RotateCredentialDialog
            credential={rotating}
            onOpenChange={(open) => {
              if (!open) setRotating(null);
            }}
            onRotated={refresh}
          />
          <ConfirmDialog
            open={Boolean(toggling)}
            onOpenChange={(open) => {
              if (!open) setToggling(null);
            }}
            title={toggling?.status === "active" ? "停用这条凭证？" : "重新启用这条凭证？"}
            description={
              toggling
                ? `${toggling.name}（${toggling.clientId}）。${
                    toggling.status === "active"
                      ? "停用后该 client_id 的所有请求立即被拒绝，密钥仍然保留。"
                      : "启用后调用方可以继续使用原 client_id 与密钥。"
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
            title="归档这条凭证？"
            description={
              archiving
                ? `${archiving.name}（${archiving.clientId}）归档后不可恢复，也不能再次启用。`
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
              如果只是想临时切断调用，请改用「停用凭证」——停用可以随时恢复。
            </p>
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}

export default function CredentialsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <CredentialsInner />
    </Suspense>
  );
}
