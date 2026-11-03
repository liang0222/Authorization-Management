"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, KeyRound, Loader2, Lock, RefreshCw, Save, ShieldCheck, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, InfoGrid, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { DetailSkeleton, ErrorState } from "@/components/app/feedback";
import { SecretReveal } from "@/components/app/secret-reveal";
import { ToneBadge } from "@/components/app/status-badge";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
  role: { id: string; code: string; name: string };
  organization: { id: string; name: string; timezone: string };
}

interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
  previewCode: string;
}

export default function ProfilePage() {
  const { session, refresh: refreshSession } = useSession();
  const { data, error, isLoading, isRefreshing, refresh } = useResource<MeResponse>("/api/v1/admin/me");

  const [displayName, setDisplayName] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileFieldErrors, setProfileFieldErrors] = useState<Record<string, string>>({});

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<Record<string, string>>({});

  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaFieldErrors, setMfaFieldErrors] = useState<Record<string, string>>({});
  const [disabling, setDisabling] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  useEffect(() => {
    if (!data) return;
    setDisplayName(data.displayName);
  }, [data]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileSaving(true);
    setProfileError(null);
    setProfileFieldErrors({});
    try {
      await apiRequest("/api/v1/admin/me", { method: "PATCH", body: { displayName: displayName.trim() } });
      toast.success("资料已保存", { description: "新的显示名称会出现在顶栏与操作审计中。" });
      refresh();
      refreshSession();
    } catch (err) {
      if (err instanceof ClientApiError) setProfileFieldErrors(err.fieldErrors);
      setProfileError(errorMessage(err));
    } finally {
      setProfileSaving(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordFieldErrors({});
    try {
      if (newPassword !== confirmPassword) {
        setPasswordFieldErrors({ confirmPassword: "两次输入的新密码不一致" });
        setPasswordError("两次输入的新密码不一致");
        return;
      }
      await apiRequest("/api/v1/admin/me", {
        method: "PUT",
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("密码已更新", { description: "其他设备上的会话已被吊销，当前会话保持登录。" });
    } catch (err) {
      if (err instanceof ClientApiError) setPasswordFieldErrors(err.fieldErrors);
      setPasswordError(errorMessage(err));
    } finally {
      setPasswordSaving(false);
    }
  };

  const beginMfa = async () => {
    setMfaBusy(true);
    setMfaError(null);
    try {
      const result = await apiRequest<MfaEnrollment>("/api/v1/admin/me?action=begin", { method: "POST" });
      setEnrollment(result);
      setMfaCode("");
      toast.success("已生成 TOTP 密钥", { description: "用认证器扫码或手动输入密钥，然后输入 6 位验证码完成绑定。" });
    } catch (err) {
      setMfaError(errorMessage(err));
    } finally {
      setMfaBusy(false);
    }
  };

  const confirmMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    setMfaBusy(true);
    setMfaError(null);
    setMfaFieldErrors({});
    try {
      await apiRequest("/api/v1/admin/me?action=confirm", { method: "POST", body: { code: mfaCode.trim() } });
      setEnrollment(null);
      setMfaCode("");
      toast.success("MFA 已启用", { description: "下次登录会要求输入动态验证码。" });
      refresh();
    } catch (err) {
      if (err instanceof ClientApiError) setMfaFieldErrors(err.fieldErrors);
      setMfaError(errorMessage(err));
    } finally {
      setMfaBusy(false);
    }
  };

  const disableMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    setMfaBusy(true);
    setMfaError(null);
    setMfaFieldErrors({});
    try {
      await apiRequest("/api/v1/admin/me?action=disable", {
        method: "POST",
        body: { password: disablePassword, code: disableCode.trim() },
      });
      setDisabling(false);
      setDisablePassword("");
      setDisableCode("");
      toast.success("MFA 已关闭", { description: "账号现在只需要邮箱与密码即可登录。" });
      refresh();
    } catch (err) {
      if (err instanceof ClientApiError) setMfaFieldErrors(err.fieldErrors);
      setMfaError(errorMessage(err));
    } finally {
      setMfaBusy(false);
    }
  };

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "个人设置" }]} title="个人设置" />
        <DetailSkeleton />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "个人设置" }]} title="个人设置" />
        <ErrorState error={error} onRetry={refresh} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "系统管理" }, { label: "个人设置" }]}
        title="个人设置"
        description="当前登录账号的资料与安全设置。这些操作只影响你自己，不会改变其他成员。"
        meta={
          data ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <ToneBadge tone="brand" dot={false}>
                {data.role.name}
              </ToneBadge>
              <ToneBadge tone={data.mfaEnabled ? "success" : "warning"} dot={false}>
                MFA {data.mfaEnabled ? "已启用" : "未启用"}
              </ToneBadge>
              <span className="text-xs text-muted-foreground">{data.organization.name}</span>
            </div>
          ) : null
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="个人资料" contentClassName="p-4">
          <form onSubmit={saveProfile} className="space-y-3">
            <FormError message={profileError} />
            <FormField label="登录邮箱" htmlFor="profile-email" hint="邮箱是登录凭据，需由其他管理员在成员页修改。">
              <Input id="profile-email" value={data?.email ?? ""} readOnly disabled className="font-mono text-xs" />
            </FormField>
            <FormField label="显示名称" htmlFor="profile-name" required error={profileFieldErrors.displayName}>
              <Input
                id="profile-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={60}
                required
              />
            </FormField>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={profileSaving || !data || displayName.trim() === data.displayName}
              >
                {profileSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存资料
              </Button>
              <span className="text-[11px] text-muted-foreground">2–60 个字符</span>
            </div>
          </form>
        </Section>

        <Section title="账号信息" contentClassName="p-4">
          <InfoGrid
            columns={2}
            items={[
              { label: "角色", value: data?.role.name ?? "", hint: data?.role.code },
              { label: "所属组织", value: data?.organization.name ?? "" },
              { label: "最近登录", value: data?.lastLoginAt ? formatDateTime(data.lastLoginAt, data.organization.timezone) : "—" },
              { label: "加入时间", value: data?.createdAt ? formatDateTime(data.createdAt, data.organization.timezone) : "—" },
            ]}
          />
          <FormHint>当前会话有效期 8 小时；修改密码后会吊销其他设备上的会话。</FormHint>
        </Section>
      </div>

      <Section id="security" title="修改密码" description="至少 10 位且同时包含字母与数字。" contentClassName="p-4">
        <form onSubmit={changePassword} className="space-y-3">
          <FormError message={passwordError} />
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="当前密码" htmlFor="pwd-current" required error={passwordFieldErrors.currentPassword}>
              <Input
                id="pwd-current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </FormField>
            <FormField label="新密码" htmlFor="pwd-new" required error={passwordFieldErrors.newPassword}>
              <Input
                id="pwd-new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </FormField>
            <FormField label="确认新密码" htmlFor="pwd-confirm" required error={passwordFieldErrors.confirmPassword}>
              <Input
                id="pwd-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </FormField>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
            >
              {passwordSaving ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
              更新密码
            </Button>
            <FormHint>改密成功后其他设备的会话立即失效，当前浏览器保持登录。</FormHint>
          </div>
        </form>
      </Section>

      <Section
        id="mfa"
        title="两步验证（MFA）"
        description="基于 TOTP 的动态验证码，登录时在密码之后额外校验一次。"
        actions={
          data?.mfaEnabled ? (
            <ToneBadge tone="success">已启用</ToneBadge>
          ) : (
            <ToneBadge tone="warning">未启用</ToneBadge>
          )
        }
        contentClassName="p-4"
      >
        <FormError message={mfaError} />

        {data?.mfaEnabled ? (
          disabling ? (
            <form onSubmit={disableMfa} className="space-y-3">
              <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
                关闭 MFA 需要同时验证当前密码与 6 位动态验证码，操作会写入审计日志。
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="当前密码" htmlFor="mfa-disable-password" required error={mfaFieldErrors.password}>
                  <Input
                    id="mfa-disable-password"
                    type="password"
                    value={disablePassword}
                    onChange={(event) => setDisablePassword(event.target.value)}
                    required
                  />
                </FormField>
                <FormField label="动态验证码" htmlFor="mfa-disable-code" required error={mfaFieldErrors.code}>
                  <Input
                    id="mfa-disable-code"
                    value={disableCode}
                    onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    className="tabular tracking-[0.3em]"
                    placeholder="000000"
                    required
                  />
                </FormField>
              </div>
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" variant="destructive" disabled={mfaBusy}>
                  {mfaBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                  确认关闭 MFA
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDisabling(false)} disabled={mfaBusy}>
                  取消
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs text-muted-foreground">
                <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span>此账号已启用两步验证。登录时需在密码之后输入认证器中的 6 位验证码。</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => setDisabling(true)}>
                <Lock className="size-3.5" /> 关闭两步验证
              </Button>
            </div>
          )
        ) : enrollment ? (
          <form onSubmit={confirmMfa} className="space-y-3">
            <SecretReveal
              title="绑定认证器"
              description="在 Google Authenticator、1Password 或 Authy 中手动添加以下密钥（或直接粘贴 otpauth 链接）。"
              secrets={[
                { label: "TOTP 密钥（Base32）", value: enrollment.secret },
                { label: "otpauth 链接", value: enrollment.otpauthUri },
              ]}
              warning="密钥只显示一次；绑定完成前请勿关闭此面板。"
            />
            <FormField
              label="6 位动态验证码"
              htmlFor="mfa-code"
              required
              error={mfaFieldErrors.code}
              hint={`服务端自检码：${enrollment.previewCode}（仅开发环境回传，真实产品不会显示）`}
            >
              <Input
                id="mfa-code"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                className="w-40 tabular tracking-[0.3em]"
                placeholder="000000"
                required
              />
            </FormField>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={mfaBusy || mfaCode.length !== 6}>
                {mfaBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Smartphone className="size-3.5" />}
                完成绑定
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEnrollment(null);
                  setMfaCode("");
                  setMfaError(null);
                }}
                disabled={mfaBusy}
              >
                取消
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              建议所有具备写权限的成员启用两步验证。启用后登录流程为：邮箱密码 → 6 位动态验证码。
            </p>
            <Button size="sm" onClick={beginMfa} disabled={mfaBusy}>
              {mfaBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Smartphone className="size-3.5" />}
              开始绑定认证器
            </Button>
          </div>
        )}
      </Section>

      <FormHint>
        当前登录：{session?.user.email ?? data?.email ?? ""}。所有安全相关操作都会写入操作审计（user.update_profile / user.change_password / user.mfa_enabled / user.mfa_disabled）。
      </FormHint>
    </div>
  );
}
