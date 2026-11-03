"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { KeyRound, Lock, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
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
  CreateSigningKeyDialog,
  SigningKeyRowActions,
  type SigningKeyRow,
  type SigningKeyStatus,
} from "@/components/security/signing-key-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { buildQuery } from "@/lib/client/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Lookups, PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<SigningKeyStatus, string> = {
  staged: "待启用",
  active: "生效中",
  retiring: "轮换中",
  revoked: "已吊销",
};

const STATUS_TONE: Record<SigningKeyStatus, Tone> = {
  staged: "info",
  active: "success",
  retiring: "warning",
  revoked: "danger",
};

const STATUS_OPTIONS: SigningKeyStatus[] = ["staged", "active", "retiring", "revoked"];

function SigningKeysPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, status: sessionStatus } = useSession();

  const canRead = hasPermission("signingkey:read");
  const canWrite = hasPermission("signingkey:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const productId = params.get("productId") ?? "";

  const [search, setSearch] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);

  const query = buildQuery({ page, pageSize, q, status, productId });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<SigningKeyRow>>(
    canRead ? `/api/v1/admin/signing-keys${query}` : null,
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
      value: STATUS_LABEL[status as SigningKeyStatus] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
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

  const columns: DataColumn<SigningKeyRow>[] = useMemo(
    () => [
      {
        key: "kid",
        header: "kid",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs whitespace-nowrap text-foreground">{row.kid}</span>
            </TooltipTrigger>
            <TooltipContent>
              私钥文件 <span className="font-mono">{row.privateKeyRef}</span> 只存在于服务器密钥目录（0600），接口与页面都不会回显私钥内容。
            </TooltipContent>
          </Tooltip>
        ),
        width: "200px",
      },
      {
        key: "algorithm",
        header: "算法",
        cell: (row) => (
          <ToneBadge tone="neutral" dot={false} className="font-mono">
            {row.algorithm}
          </ToneBadge>
        ),
        width: "90px",
      },
      {
        key: "product",
        header: "关联产品",
        cell: (row) =>
          row.product ? (
            <div className="min-w-0">
              <p className="truncate text-xs text-foreground">{row.product.name}</p>
              <p className="truncate font-mono text-[10px] text-muted-foreground">{row.product.code}</p>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">组织通用</span>
          ),
        width: "150px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => <ToneBadge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</ToneBadge>,
        width: "100px",
      },
      {
        key: "fingerprint",
        header: "公钥指纹",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-[11px] break-all text-muted-foreground">
                {row.publicKeyFingerprint}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              指纹 = SHA-256(公钥) 的前 16 字节，可公开核对；指纹无法还原公钥，更不可能复制私钥。
            </TooltipContent>
          </Tooltip>
        ),
        width: "190px",
      },
      {
        key: "window",
        header: "生效 / 到期",
        cell: (row) => (
          <div className="space-y-0.5 text-[11px]">
            <p className="text-muted-foreground">生效 {formatDateTime(row.notBefore)}</p>
            <p className={cn("tabular", row.notAfter ? "text-foreground" : "text-muted-foreground")}>
              {row.notAfter ? `到期 ${formatDateTime(row.notAfter)}` : "长期有效"}
            </p>
          </div>
        ),
        width: "170px",
      },
      {
        key: "created",
        header: "创建时间",
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
          <SigningKeyRowActions id={row.id} kid={row.kid} status={row.status} onChanged={refresh} />
        ),
        width: "80px",
      },
    ],
    // 列定义只依赖静态映射；刷新通过 onChanged 回调完成
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "安全审计" }, { label: "签名密钥" }]}
        title="签名密钥"
        description="离线授权用 Ed25519 密钥签名。私钥生成后只写入服务器受限目录（0600），页面与接口都不会回显；吊销是终态，不能恢复。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 把密钥
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
                <Plus className="size-3.5" /> 生成签名密钥
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>
          私钥不可回显：页面只展示 kid、算法与公钥指纹。
          <span className="font-medium text-foreground">吊销不可恢复</span>
          ，已签发的离线授权在有效期内仍可用旧公钥验证，但系统不再签发新文件。
        </p>
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
          searchPlaceholder="按 kid 搜索…"
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
                <SelectTrigger size="sm" className="h-8 w-[136px] text-xs" aria-label="按密钥状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {STATUS_LABEL[option]}
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
                <SelectTrigger size="sm" className="h-8 w-[168px] text-xs" aria-label="按产品筛选">
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
              title="没有查看签名密钥的权限"
              description="需要 signingkey:read 权限。导航隐藏不是权限控制，接口同样会拒绝这次请求。"
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
              caption="签名密钥列表"
              empty={
                <EmptyState
                  icon={<KeyRound className="size-5" />}
                  title={chips.length > 0 ? "没有符合筛选条件的密钥" : "还没有签名密钥"}
                  description={
                    chips.length > 0
                      ? "尝试放宽筛选条件，或清空筛选后重新查看。"
                      : "生成第一把密钥后，离线授权文件才能被客户端验证。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="size-3.5" /> 生成签名密钥
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
                onPageChange={(nextPage) =>
                  updateParams((next) => {
                    next.set("page", String(nextPage));
                  })
                }
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

      {canWrite ? <CreateSigningKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} /> : null}
    </div>
  );
}

export default function SigningKeysPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <SigningKeysPageInner />
    </Suspense>
  );
}
