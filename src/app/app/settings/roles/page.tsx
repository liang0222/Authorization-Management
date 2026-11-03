"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Lock, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge } from "@/components/app/status-badge";
import { FormError, FormField } from "@/components/app/form-field";
import { apiRequest, errorMessage } from "@/lib/client/api";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 角色与权限（规格 2.3-A、15.4）。
 *
 * 数据来源 `GET /api/v1/admin/roles`：角色列表 + 权限目录（availablePermissions）。
 * 权限目录由服务端从 `PERMISSIONS` 派生，前端不硬编码，新增权限码无需改这个页面。
 *
 * 只做「看 + 建自定义角色」：角色改名/删除没有对应接口，页面不提供假按钮。
 */

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isPreset: boolean;
  permissionCodes: string[];
  permissionsDerived: boolean;
  memberCount: number;
  activeMemberCount: number;
  createdAt: string;
}

interface PermissionOption {
  code: string;
  description: string;
  group: string;
}

interface RolesResponse {
  items: RoleRow[];
  availablePermissions: PermissionOption[];
}

function CreateRoleDialog({
  open,
  onOpenChange,
  permissions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permissions: PermissionOption[];
  onCreated: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const groups = useMemo(() => {
    const map = new Map<string, PermissionOption[]>();
    for (const permission of permissions) {
      const list = map.get(permission.group) ?? [];
      list.push(permission);
      map.set(permission.group, list);
    }
    return Array.from(map.entries());
  }, [permissions]);

  const reset = () => {
    setCode("");
    setName("");
    setSelected([]);
    setError(null);
    setFieldErrors({});
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiRequest<{ id: string }>("/api/v1/admin/roles", {
        method: "POST",
        body: { code: code.trim(), name: name.trim(), permissionCodes: selected },
      });
      toast.success("角色已创建");
      reset();
      onCreated();
      onOpenChange(false);
    } catch (caught) {
      const field = errorMessage(caught);
      setError(field);
      const details = (caught as { details?: { fieldErrors?: Record<string, string> } })?.details;
      if (details?.fieldErrors) setFieldErrors(details.fieldErrors);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>新建自定义角色</DialogTitle>
            <DialogDescription>
              角色编码创建后不可修改，用于区分预设角色与自定义权限组合。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="角色名称" required error={fieldErrors.name}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：只读客服"
                maxLength={120}
              />
            </FormField>
            <FormField
              label="角色编码"
              required
              error={fieldErrors.code}
              hint="只能包含小写字母、数字、- 和 _，且以字母开头。"
            >
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="例如：support-readonly"
                maxLength={80}
                className="font-mono"
              />
            </FormField>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">权限（已选 {selected.length} 项）</Label>
            <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-border p-3">
              {groups.map(([group, list]) => (
                <div key={group} className="space-y-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {list.map((permission) => {
                      const checked = selected.includes(permission.code);
                      return (
                        <label
                          key={permission.code}
                          className={cn(
                            "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60",
                            checked && "bg-muted/40",
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) =>
                              setSelected((current) =>
                                next
                                  ? [...current, permission.code]
                                  : current.filter((item) => item !== permission.code),
                              )
                            }
                            className="mt-0.5"
                          />
                          <span className="space-y-0.5">
                            <span className="block font-mono text-[11px] text-foreground">{permission.code}</span>
                            <span className="block text-[11px] text-muted-foreground">{permission.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {fieldErrors.permissionCodes ? (
              <p className="text-[11px] text-destructive">{fieldErrors.permissionCodes}</p>
            ) : null}
          </div>

          <FormError message={error} />

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              创建角色
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RolesInner() {
  const { status: sessionStatus, hasPermission } = useSession();
  const { data, error, isLoading, isRefreshing, refresh } = useResource<RolesResponse>(
    "/api/v1/admin/roles",
  );
  const [createOpen, setCreateOpen] = useState(false);

  const canRead = sessionStatus !== "ready" || hasPermission("member:read");
  const canWrite = hasPermission("member:write");

  if (sessionStatus === "ready" && !canRead) {
    return (
      <EmptyState
        title="没有查看角色的权限"
        description="当前角色缺少 member:read 权限，请联系所有者分配。"
        action={
          <Button size="sm" asChild>
            <Link href="/app/dashboard">返回数据总览</Link>
          </Button>
        }
      />
    );
  }

  if (isLoading) return <DetailSkeleton />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const { items, availablePermissions } = data;
  const permissionByCode = new Map(availablePermissions.map((item) => [item.code, item]));

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[
          { label: "系统管理" },
          { label: "管理员与角色", href: "/app/settings/members" },
          { label: "角色与权限" },
        ]}
        title="角色与权限"
        description="角色决定管理员能看到哪些页面、能调用哪些接口；系统预设角色不可修改。"
        meta={
          <>
            <span className="text-xs text-muted-foreground">共 {items.length} 个角色</span>
            <span className="text-xs text-muted-foreground">
              权限码 {availablePermissions.length} 项
            </span>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} /> 刷新
            </Button>
            {canWrite ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-3.5" /> 新建角色
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((role) => {
          const grouped = new Map<string, string[]>();
          for (const code of role.permissionCodes) {
            const group = permissionByCode.get(code)?.group ?? "未分组";
            const list = grouped.get(group) ?? [];
            list.push(code);
            grouped.set(group, list);
          }
          return (
            <Section
              key={role.id}
              title={role.name}
              description={role.description ?? "自定义角色"}
              actions={
                <div className="flex items-center gap-1.5">
                  {role.isSystem ? (
                    <ToneBadge tone="info">
                      <Lock className="mr-1 size-3" /> 系统预设
                    </ToneBadge>
                  ) : (
                    <ToneBadge tone="neutral">自定义</ToneBadge>
                  )}
                  <ToneBadge tone={role.memberCount > 0 ? "success" : "neutral"}>
                    <Users className="mr-1 size-3" /> {role.memberCount}
                  </ToneBadge>
                </div>
              }
            >
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="font-mono text-foreground">{role.code}</span>
                  <span>启用中成员 {role.activeMemberCount} / {role.memberCount}</span>
                  <span>创建于 {formatDateTime(role.createdAt)}</span>
                </div>

                {role.permissionsDerived ? (
                  <p className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
                    该角色在库里没有显式权限记录，下面按同编码预设补齐显示，仅用于展示。
                  </p>
                ) : null}

                <div className="space-y-1.5">
                  {Array.from(grouped.entries()).map(([group, codes]) => (
                    <div key={group} className="space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">{group}</p>
                      <div className="flex flex-wrap gap-1">
                        {codes.map((code) => (
                          <span
                            key={code}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                            title={permissionByCode.get(code)?.description ?? code}
                          >
                            <Check className="size-2.5 text-muted-foreground" />
                            {code}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {grouped.size === 0 ? (
                    <p className="text-xs text-muted-foreground">该角色没有任何权限，成员登录后只能看到空工作台。</p>
                  ) : null}
                </div>
              </div>
            </Section>
          );
        })}
      </div>

      <Section
        title="权限目录"
        description="权限码由服务端 PERMISSIONS 派生；新增权限码后这里会自动出现。"
      >
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {availablePermissions.map((permission) => (
            <div key={permission.code} className="rounded-md border border-border px-2 py-1.5">
              <p className="font-mono text-[11px] text-foreground">{permission.code}</p>
              <p className="text-[11px] text-muted-foreground">{permission.description}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {permission.group}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="size-3.5" />
        角色权限只影响后台管理端；客户端校验由授权与功能权限决定，与角色无关。
      </p>

      <CreateRoleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        permissions={availablePermissions}
        onCreated={refresh}
      />
    </div>
  );
}

export default function RolesPage() {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <RolesInner />
    </Suspense>
  );
}
