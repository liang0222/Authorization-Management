"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { History, RefreshCw, ShieldAlert, X } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { PaginationBar } from "@/components/app/pagination-bar";
import { FilterBar, type FilterChip } from "@/components/app/filter-bar";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge } from "@/components/app/status-badge";
import { AuditLogDrawer, type AuditLogRow } from "@/components/security/log-drawers";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { buildQuery } from "@/lib/client/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const RESOURCE_TYPES = [
  { value: "license", label: "授权" },
  { value: "activation", label: "激活" },
  { value: "product", label: "产品" },
  { value: "customer", label: "客户" },
  { value: "plan", label: "套餐" },
  { value: "feature", label: "功能权限" },
  { value: "credential", label: "API 凭证" },
  { value: "signing_key", label: "签名密钥" },
  { value: "webhook", label: "Webhook" },
  { value: "member", label: "成员" },
  { value: "role", label: "角色" },
  { value: "organization", label: "组织" },
  { value: "settings", label: "系统设置" },
];

const ACTION_PRESETS = [
  { value: "license.issue", label: "签发授权" },
  { value: "license.renew", label: "续费授权" },
  { value: "license.suspend", label: "暂停授权" },
  { value: "license.revoke", label: "吊销授权" },
  { value: "license.rekey", label: "更换授权码" },
  { value: "license.export", label: "导出授权" },
  { value: "activation.release", label: "解绑设备" },
  { value: "activation.block", label: "封禁设备" },
  { value: "credential.create", label: "创建凭证" },
  { value: "credential.rotate", label: "轮换密钥" },
  { value: "member.invite", label: "邀请成员" },
];

function actionTone(action: string): "danger" | "warning" | "info" | "neutral" {
  if (action.includes("revoke") || action.includes("archive") || action.includes("delete")) return "danger";
  if (action.includes("suspend") || action.includes("block") || action.includes("disable")) return "warning";
  if (action.includes("issue") || action.includes("create") || action.includes("invite")) return "info";
  return "neutral";
}

function AuditLogsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, session, status: sessionStatus } = useSession();

  const canRead = hasPermission("audit:read");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const action = params.get("action") ?? "";
  const resourceType = params.get("resourceType") ?? "";

  const [search, setSearch] = useState(q);
  const [actionInput, setActionInput] = useState(action);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);

  const query = buildQuery({ page, pageSize, q, action, resourceType });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<AuditLogRow>>(
    canRead ? `/api/v1/admin/audit-logs${query}` : null,
  );

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const searchString = next.toString();
    router.replace(searchString ? `${pathname}?${searchString}` : pathname, { scroll: false });
  };

  const resetFilters = () => {
    setSearch("");
    setActionInput("");
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
  if (action) {
    chips.push({
      label: "操作",
      value: ACTION_PRESETS.find((item) => item.value === action)?.label ?? action,
      onRemove: () => {
        setActionInput("");
        updateParams((next) => next.delete("action"));
      },
    });
  }
  if (resourceType) {
    chips.push({
      label: "资源",
      value: RESOURCE_TYPES.find((item) => item.value === resourceType)?.label ?? resourceType,
      onRemove: () => updateParams((next) => next.delete("resourceType")),
    });
  }

  const columns: DataColumn<AuditLogRow>[] = useMemo(
    () => [
      {
        key: "createdAt",
        header: "时间",
        cell: (row) => (
          <span className="tabular whitespace-nowrap text-[11px] text-muted-foreground">
            {formatDateTime(row.createdAt, session?.organization.timezone)}
          </span>
        ),
        width: "150px",
      },
      {
        key: "actor",
        header: "操作者",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">
              {row.actorName ?? (row.actorType === "system" ? "系统" : row.actorType)}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">{row.actorEmail ?? row.actorType}</p>
          </div>
        ),
        width: "160px",
      },
      {
        key: "action",
        header: "操作",
        cell: (row) => (
          <ToneBadge tone={actionTone(row.action)} dot={false} className="font-mono text-[10px]">
            {row.action}
          </ToneBadge>
        ),
        width: "170px",
      },
      {
        key: "resource",
        header: "资源",
        cell: (row) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.resourceType}
            {row.resourceId ? ` / ${row.resourceId.slice(0, 8)}…` : ""}
          </span>
        ),
        width: "150px",
      },
      {
        key: "changedFields",
        header: "变更字段",
        cell: (row) =>
          row.changedFields.length > 0 ? (
            <span className="line-clamp-1 font-mono text-[11px] text-foreground">{row.changedFields.join("、")}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          ),
      },
      {
        key: "ip",
        header: "来源 IP",
        cell: (row) => <span className="font-mono text-[11px] text-muted-foreground">{row.ip ?? "—"}</span>,
        width: "120px",
      },
    ],
    [session?.organization.timezone],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "安全审计" }, { label: "操作审计" }]}
        title="操作审计"
        description="所有管理后台写操作的追加式记录：谁在什么时候、从哪个 IP 改了什么。审计记录不可修改、不可删除。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{formatNumber(data.total)}</span> 条审计记录
            </span>
          ) : null
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading || !canRead}>
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
          </Button>
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
          searchPlaceholder="按操作、资源类型或 request_id 搜索…"
          chips={chips}
          onReset={resetFilters}
          filters={
            <>
              <Select
                value={action || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") {
                      next.delete("action");
                      setActionInput("");
                    } else {
                      next.set("action", value);
                      setActionInput(value);
                    }
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="按操作类型筛选">
                  <SelectValue placeholder="全部操作" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部操作</SelectItem>
                  {ACTION_PRESETS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                value={actionInput}
                onChange={(event) => setActionInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  updateParams((next) => {
                    if (actionInput.trim()) next.set("action", actionInput.trim());
                    else next.delete("action");
                    next.set("page", "1");
                  });
                }}
                placeholder="或输入操作前缀 license."
                className="h-8 w-[190px] font-mono text-xs"
                aria-label="按操作名模糊筛选"
              />

              <Select
                value={resourceType || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("resourceType");
                    else next.set("resourceType", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[130px] text-xs" aria-label="按资源类型筛选">
                  <SelectValue placeholder="全部资源" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部资源</SelectItem>
                  {RESOURCE_TYPES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
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
              title="没有查看操作审计的权限"
              description="需要 audit:read 权限，接口同样会拒绝这次请求。"
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
              onRowClick={(row) => setSelected(row)}
              caption="操作审计列表"
              empty={
                <EmptyState
                  icon={<History className="size-5" />}
                  title={chips.length > 0 ? "没有符合条件的审计记录" : "还没有审计记录"}
                  description={
                    chips.length > 0
                      ? "换一个操作名、资源类型或关键词，或清空筛选。"
                      : "后台的第一次写操作（签发授权、修改产品等）会在这里留下记录。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
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

      <AuditLogDrawer
        row={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        timeZone={session?.organization.timezone}
      />
    </div>
  );
}

export default function AuditLogsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <AuditLogsInner />
    </Suspense>
  );
}
