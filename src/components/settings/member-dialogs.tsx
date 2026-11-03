"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { SecretReveal } from "@/components/app/secret-reveal";
import { ToneBadge } from "@/components/app/status-badge";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";

export interface MemberRow {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  role: { id: string; code: string; name: string };
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleOption {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  isPreset: boolean;
  memberCount: number;
}

export const MEMBER_STATUS_LABEL: Record<string, string> = {
  active: "在职",
  disabled: "已停用",
};

/** 邀请成员：服务端可生成一次性初始密码，仅在响应里返回一次。 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  roles,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleOption[];
  onInvited: () => void;
}) {
  const invitable = roles.filter((role) => role.code !== "owner");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleCode, setRoleCode] = useState(invitable.find((role) => role.code === "operator")?.code ?? invitable[0]?.code ?? "");
  const [tempPassword, setTempPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ email: string; tempPassword?: string; userReused?: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setDisplayName("");
    setRoleCode(invitable.find((role) => role.code === "operator")?.code ?? invitable[0]?.code ?? "");
    setTempPassword("");
    setError(null);
    setFieldErrors({});
    setResult(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const data = await apiRequest<{ email: string; tempPassword?: string; userReused?: boolean }>(
        "/api/v1/admin/members",
        {
          method: "POST",
          body: {
            email: email.trim(),
            displayName: displayName.trim(),
            roleCode,
            tempPassword: tempPassword.trim() || undefined,
          },
        },
      );
      setResult(data);
      onInvited();
      toast.success("成员已加入组织", { description: `${displayName} 现在可以使用该邮箱登录后台。` });
    } catch (err) {
      if (err instanceof ClientApiError) setFieldErrors(err.fieldErrors);
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{result ? "成员已加入" : "邀请成员"}</DialogTitle>
          <DialogDescription>
            {result
              ? "把初始密码通过安全渠道交给对方，对方首次登录后应立即修改。"
              : "邀请后对方即可用该邮箱登录后台，权限由所选角色决定。组织只能有一个所有者。"}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            {result.tempPassword ? (
              <SecretReveal
                title="初始登录凭证"
                description={result.userReused ? "该邮箱已有账号，已加入本组织。" : "账号已创建。"}
                secrets={[
                  { label: "登录邮箱", value: result.email },
                  { label: "初始密码（仅显示一次）", value: result.tempPassword },
                ]}
                warning="关闭后无法再次查看明文；如丢失请在成员菜单里重置密码。"
              />
            ) : (
              <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                使用你填写的初始密码；请确认已通过安全渠道告知 {result.email}。
              </div>
            )}
            <DialogFooter>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                完成
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form id="invite-member-form" className="space-y-3" onSubmit={submit}>
            <FormError message={error} />
            <FormField label="登录邮箱" htmlFor="invite-email" required error={fieldErrors.email}>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                required
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="显示名称" htmlFor="invite-name" required error={fieldErrors.displayName}>
                <Input
                  id="invite-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="张三"
                  required
                />
              </FormField>
              <FormField label="角色" required error={fieldErrors.roleCode}>
                <Select value={roleCode} onValueChange={setRoleCode}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择角色" />
                  </SelectTrigger>
                  <SelectContent>
                    {invitable.map((role) => (
                      <SelectItem key={role.id} value={role.code}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField
              label="初始密码"
              htmlFor="invite-password"
              error={fieldErrors.tempPassword}
              hint="留空则由服务端生成 12 位随机密码，并在创建后显示一次。"
            >
              <Input
                id="invite-password"
                value={tempPassword}
                onChange={(event) => setTempPassword(event.target.value)}
                placeholder="留空自动生成"
                className="font-mono text-xs"
              />
            </FormField>
            <FormHint>密码要求：至少 10 位且同时包含字母与数字。</FormHint>
          </form>
        )}

        {result ? null : (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" form="invite-member-form" size="sm" disabled={submitting}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              邀请成员
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 编辑成员：改角色、停用 / 启用。owner 成员由接口直接拒绝。 */
export function EditMemberDialog({
  member,
  onOpenChange,
  roles,
  currentUserId,
  onSaved,
}: {
  member: MemberRow | null;
  onOpenChange: (open: boolean) => void;
  roles: RoleOption[];
  currentUserId: string | undefined;
  onSaved: () => void;
}) {
  const [roleCode, setRoleCode] = useState("");
  const [status, setStatus] = useState("active");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!member) return;
    setRoleCode(member.role.code);
    setStatus(member.status);
    setError(null);
    setFieldErrors({});
  }, [member]);

  const isOwner = member?.role.code === "owner";
  const isSelf = member?.userId === currentUserId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!member) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiRequest(`/api/v1/admin/members/${member.membershipId}`, {
        method: "PATCH",
        body: { roleCode, status },
      });
      toast.success("成员已更新", { description: "新的角色与状态立即生效。" });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ClientApiError) setFieldErrors(err.fieldErrors);
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(member)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>编辑成员</DialogTitle>
          <DialogDescription>
            {member ? `${member.displayName}（${member.email}）` : ""}
          </DialogDescription>
        </DialogHeader>

        <form id="edit-member-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />

          {isOwner ? (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
              所有者成员的角色与状态不可修改。如需转移所有权，请新建一个 owner 角色成员后再停用当前账号。
            </div>
          ) : null}

          {isSelf ? (
            <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
              这是你自己的成员身份：角色可以调整，但不能停用自己（接口返回 400）。
            </div>
          ) : null}

          <FormField label="角色" required error={fieldErrors.roleCode}>
            <Select value={roleCode} onValueChange={setRoleCode} disabled={isOwner}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.code}>
                    {role.name}
                    {role.isPreset ? "（预设）" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="成员状态" error={fieldErrors.status}>
            <Select value={status} onValueChange={setStatus} disabled={isOwner}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">在职（可登录）</SelectItem>
                <SelectItem value="disabled">已停用（不可登录）</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <div className="flex flex-wrap gap-1.5">
            <ToneBadge tone="neutral" dot={false}>
              MFA {member?.mfaEnabled ? "已启用" : "未启用"}
            </ToneBadge>
            <ToneBadge tone="neutral" dot={false}>
              加入时间 {member?.createdAt.slice(0, 10)}
            </ToneBadge>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="edit-member-form" size="sm" disabled={submitting || isOwner}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
