"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, ClientApiError } from "@/lib/client/api";
import { FormError } from "@/components/app/form-field";

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    setError(null);
    if (password !== confirm) {
      setFieldErrors({ confirm: "两次输入的密码不一致" });
      return;
    }
    setLoading(true);
    try {
      await apiRequest("/api/v1/auth/reset-password", {
        method: "POST",
        body: { token, password },
      });
      toast.success("密码已更新，请使用新密码登录");
      router.replace("/login");
    } catch (cause) {
      if (cause instanceof ClientApiError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors);
      } else {
        setError("重置失败，请稍后重试");
      }
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">重置链接无效</h1>
        <p className="text-sm text-muted-foreground">链接缺少必要参数，请重新申请重置密码。</p>
        <Button asChild className="w-full">
          <Link href="/forgot-password">重新申请</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">设置新密码</h1>
        <p className="text-sm text-muted-foreground">密码至少 10 位，且同时包含字母与数字。重置后所有已登录会话将失效。</p>
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="password">新密码</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(fieldErrors.password)}
            disabled={loading}
          />
          {fieldErrors.password ? <p className="text-xs text-destructive">{fieldErrors.password}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">确认新密码</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={Boolean(fieldErrors.confirm)}
            disabled={loading}
          />
          {fieldErrors.confirm ? <p className="text-xs text-destructive">{fieldErrors.confirm}</p> : null}
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={loading || !password || !confirm}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {loading ? "正在保存…" : "保存新密码"}
        </Button>
        <Button variant="ghost" asChild className="w-full">
          <Link href="/login">
            <ArrowLeft className="size-4" /> 返回登录
          </Link>
        </Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted/50" aria-hidden />}>
      <ResetForm />
    </Suspense>
  );
}
