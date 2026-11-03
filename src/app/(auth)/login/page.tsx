"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/client/session-context";
import { Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, ClientApiError } from "@/lib/client/api";
import { FormError } from "@/components/app/form-field";

interface LoginResponse {
  user: { id: string; displayName: string; email: string };
  organization: { name: string };
  role: { name: string };
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/app/dashboard";
  const { refresh: refreshSession } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 已登录则直接进入后台，避免重复登录
  useEffect(() => {
    apiRequest("/api/v1/auth/session")
      .then(async () => {
        await refreshSession();
        router.replace(next);
      })
      .catch(() => undefined);
  }, [router, next, refreshSession]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await apiRequest<LoginResponse>("/api/v1/auth/login", {
        method: "POST",
        body: { email, password, totp: totp || undefined },
      });
      toast.success(`欢迎回来，${result.user.displayName}`);
      // SessionProvider 挂在根布局上，登录前拿到的是 401；这里必须主动刷新，
      // 否则 AppShell 仍按「未登录」把用户弹回 /login，形成登录页 ↔ 后台的循环跳转。
      await refreshSession();
      router.replace(next);
      router.refresh();
    } catch (cause) {
      if (cause instanceof ClientApiError) {
        if (cause.code === "MFA_REQUIRED") {
          setMfaRequired(true);
          setError(cause.message);
        } else {
          setError(cause.message);
          setFieldErrors(cause.fieldErrors);
          if (cause.code === "CLIENT_AUTH_FAILED") setPassword("");
        }
      } else {
        setError("登录失败，请稍后重试");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 lg:hidden">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            Z
          </span>
          <span className="text-sm font-semibold">子铭</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">登录授权管理后台</h1>
        <p className="text-sm text-muted-foreground">使用组织管理员账号登录，所有操作都会记入审计日志。</p>
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@xinglan.dev"
            aria-invalid={Boolean(fieldErrors.email)}
            disabled={loading}
          />
          {fieldErrors.email ? <p className="text-xs text-destructive">{fieldErrors.email}</p> : null}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">密码</Label>
            <Link href="/forgot-password" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
              忘记密码？
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••"
            aria-invalid={Boolean(fieldErrors.password)}
            disabled={loading}
          />
          {fieldErrors.password ? <p className="text-xs text-destructive">{fieldErrors.password}</p> : null}
        </div>

        {mfaRequired ? (
          <div className="space-y-1.5">
            <Label htmlFor="totp">动态验证码</Label>
            <Input
              id="totp"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={totp}
              onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
              placeholder="6 位数字"
              autoFocus
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">该账号已启用两步验证，请输入验证器 App 中的 6 位验证码。</p>
          </div>
        ) : null}

        <FormError message={error} />

        <Button type="submit" className="w-full" disabled={loading || !email || !password}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
          {loading ? "正在登录…" : "登录"}
        </Button>
      </form>

      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">演示环境账号（种子数据）</p>
        <ul className="mt-1 space-y-0.5">
          <li>所有者：owner@xinglan.dev / License#2026</li>
          <li>运营：ops@xinglan.dev / License#2026</li>
          <li>只读：audit@xinglan.dev / License#2026</li>
        </ul>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted/50" aria-hidden />}>
      <LoginForm />
    </Suspense>
  );
}
