"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Pencil, RefreshCw, ShieldAlert, UserMinus, UserPlus, Users, X } from "lucide-react";
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
import { ToneBadge } from "@/components/app/status-badge";
import {
  EditMemberDialog,
  InviteMemberDialog,
  MEMBER_STATUS_LABEL,
  type MemberRow,
  type RoleOption,
} from "@/components/settings/member-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, buildQuery } from "@/lib/client/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RolesResponse {
  items: RoleOption[];
}

function MembersInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { hasPermission, session, status: sessionStatus } = useSession();

  const canRead = hasPermission("member:read");
  const canWrite = hasPermission("member:write");
  const denied = sessionStatus === "ready" && !canRead;

  const page = Number(params.get("page") ?? 1) || 1;
  const pageSize = Number(params.get("pageSize") ?? 20) || 20;
  const q = params.get("q") ?? "";
  const roleCode = params.get("roleCode") ?? "";
  const status = params.get("status") ?? "";

  const [search, setSearch] = useState(q);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const [removing, setRemoving] = useState<MemberRow | null>(null);

  const query = buildQuery({ page, pageSize, q, roleCode, status });
  const { data, error, isLoading, isRefreshing, refresh } = useResource<PageResult<MemberRow>>(
    canRead ? `/api/v1/admin/members${query}` : null,
  );
  const roles = useResource<RolesResponse>(canRead ? "/api/v1/admin/roles" : null);

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

  const disable = async (row: MemberRow) => {
    await apiRequest(`/api/v1/admin/members/${row.membershipId}`, { method: "DELETE" });
    toast.success("成员已停用", { description: `${row.displayName} 现在无法登录后台，可随时重新启用。` });
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
  if (roleCode) {
    const role = roles.data?.items.find((item) => item.code === roleCode);
    chips.push({
      label: "角色",
      value: role?.name ?? roleCode,
      onRemove: () => updateParams((next) => next.delete("roleCode")),
    });
  }
  if (status) {
    chips.push({
      label: "状态",
      value: MEMBER_STATUS_LABEL[status] ?? status,
      onRemove: () => updateParams((next) => next.delete("status")),
    });
  }

  const columns: DataColumn<MemberRow>[] = useMemo(
    () => [
      {
        key: "displayName",
        header: "成员",
        cell: (row) => (
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
              {row.displayName}
              {row.userId === session?.user.id ? (
                <ToneBadge tone="brand" dot={false} className="text-[10px]">
                  你
                </ToneBadge>
              ) : null}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{row.email}</p>
          </div>
        ),
      },
      {
        key: "role",
        header: "角色",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <ToneBadge tone={row.role.code === "owner" ? "brand" : "neutral"} dot={false}>
                  {row.role.name}
                </ToneBadge>
              </span>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-[11px]">{row.role.code}</TooltipContent>
          </Tooltip>
        ),
        width: "130px",
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={row.status === "active" ? "success" : "neutral"}>
            {MEMBER_STATUS_LABEL[row.status] ?? row.status}
          </ToneBadge>
        ),
        width: "100px",
      },
      {
        key: "mfa",
        header: "MFA",
        cell: (row) => (
          <ToneBadge tone={row.mfaEnabled ? "success" : "warning"} dot={false}>
            {row.mfaEnabled ? "已启用" : "未启用"}
          </ToneBadge>
        ),
        width: "100px",
      },
      {
        key: "lastLoginAt",
        header: "最近登录",
        cell: (row) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-[11px] text-muted-foreground">
                {row.lastLoginAt ? formatRelative(row.lastLoginAt) : "从未登录"}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {row.lastLoginAt ? formatDateTime(row.lastLoginAt, session?.organization.timezone) : "该账号尚未登录过"}
            </TooltipContent>
          </Tooltip>
        ),
        width: "120px",
      },
      {
        key: "createdAt",
        header: "加入时间",
        cell: (row) => (
          <span className="text-[11px] text-muted-foreground">
            {formatDateTime(row.createdAt, session?.organization.timezone)}
          </span>
        ),
        width: "150px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) =>
          canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={`成员 ${row.displayName} 的操作菜单`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => setEditing(row)}>
                  <Pencil className="size-3.5" /> 编辑角色与状态
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setRemoving(row)}
                  disabled={row.role.code === "owner" || row.userId === session?.user.id}
                  variant="destructive"
                >
                  <UserMinus className="size-3.5" /> 停用成员
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
        width: "60px",
      },
    ],
    [canWrite, session?.organization.timezone, session?.user.id],
  );

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "系统管理" }, { label: "管理员与角色" }]}
        title="管理员与角色"
        description="后台账号与权限分配。角色决定能看到哪些导航、能点哪些按钮；每个 API 都会再校验一次权限。"
        meta={
          data ? (
            <span className="text-xs text-muted-foreground">
              共 <span className="tabular font-medium text-foreground">{data.total}</span> 位成员
            </span>
          ) : null
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading || !canRead}>
              <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
            </Button>
            {canWrite ? (
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlus className="size-3.5" /> 邀请成员
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <UserPlus className="size-3.5" /> 邀请成员
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>当前角色没有 member:write 权限</TooltipContent>
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
          searchPlaceholder="按姓名或邮箱搜索…"
          chips={chips}
          onReset={resetFilters}
          filters={
            <>
              <Select
                value={roleCode || "all"}
                onValueChange={(value) =>
                  updateParams((next) => {
                    if (value === "all") next.delete("roleCode");
                    else next.set("roleCode", value);
                    next.set("page", "1");
                  })
                }
              >
                <SelectTrigger size="sm" className="h-8 w-[140px] text-xs" aria-label="按角色筛选成员">
                  <SelectValue placeholder="全部角色" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部角色</SelectItem>
                  {(roles.data?.items ?? []).map((role) => (
                    <SelectItem key={role.id} value={role.code}>
                      {role.name}
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
                <SelectTrigger size="sm" className="h-8 w-[120px] text-xs" aria-label="按成员状态筛选">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="active">在职</SelectItem>
                  <SelectItem value="disabled">已停用</SelectItem>
                </SelectContent>
              </Select>
            </>
          }
        />

        {denied ? (
          <div className="p-4">
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title="没有查看成员的权限"
              description="需要 member:read 权限，接口同样会拒绝这次请求。"
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
              rowKey={(row) => row.membershipId}
              loading={isLoading || isRefreshing}
              caption="管理员成员列表"
              empty={
                <EmptyState
                  icon={<Users className="size-5" />}
                  title={chips.length > 0 ? "没有符合条件的成员" : "还没有其他成员"}
                  description={
                    chips.length > 0
                      ? "换一个关键词、角色或状态，或清空筛选。"
                      : "邀请同事加入后，他们会出现在这里；权限按角色自动分配。"
                  }
                  action={
                    chips.length > 0 ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <X className="size-3.5" /> 清空筛选
                      </Button>
                    ) : canWrite ? (
                      <Button size="sm" onClick={() => setInviteOpen(true)}>
                        <UserPlus className="size-3.5" /> 邀请成员
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
          <InviteMemberDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            roles={roles.data?.items ?? []}
            onInvited={refresh}
          />
          <EditMemberDialog
            member={editing}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            roles={roles.data?.items ?? []}
            currentUserId={session?.user.id}
            onSaved={refresh}
          />
          <ConfirmDialog
            open={Boolean(removing)}
            onOpenChange={(open) => {
              if (!open) setRemoving(null);
            }}
            title="停用这个成员？"
            description={
              removing ? `${removing.displayName}（${removing.email}）将立即无法登录，已有的会话会被拒绝。` : ""
            }
            confirmLabel="停用成员"
            tone="danger"
            onConfirm={async () => {
              if (removing) await disable(removing);
              setRemoving(null);
            }}
          >
            <p className="text-xs text-muted-foreground">
              这是可恢复操作：随时可以在成员菜单里重新启用。所有者成员不能被停用。
            </p>
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}

export default function MembersPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <MembersInner />
    </Suspense>
  );
}
