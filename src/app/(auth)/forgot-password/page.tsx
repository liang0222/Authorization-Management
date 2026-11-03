"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, ClientApiError } from "@/lib/client/api";
import { FormError } from "@/components/app/form-field";

interface ForgotResponse {
  submitted: boolean;
  devResetUrl: string | null;
  mailDeliveryConfigured: boolean;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState<ForgotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<ForgotResponse>("/api/v1/auth/forgot-password", {
        method: "POST",
        body: { email },
      });
      setSubmitted(result);
    } catch (cause) {
      setError(cause instanceof ClientApiError ? cause.message : "提交失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">重置密码</h1>
        <p className="text-sm text-muted-foreground">输入账号邮箱，我们会生成一次有效期为 30 分钟的重置链接。</p>
      </div>

      {submitted ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-3 text-sm">
            <MailCheck className="mt-0.5 size-4 text-success" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium text-foreground">如果该邮箱已注册，重置邮件已生成</p>
              <p className="text-xs text-muted-foreground">
                为防账号枚举，无论邮箱是否存在都会显示相同结果。
              </p>
            </div>
          </div>
          {submitted.devResetUrl ? (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/[0.07] p-3">
              <p className="text-xs font-medium text-foreground">开发模式：邮件出口未配置，请直接使用下面的重置链接</p>
              <Link
                href={submitted.devResetUrl}
                className="block truncate font-mono text-xs text-primary underline underline-offset-2"
              >
                {submitted.devResetUrl}
              </Link>
              <p className="text-[11px] text-muted-foreground">
                生产环境应设置 DEV_MAIL_SINK=false，由邮件服务投递，链接不会返回给浏览器。
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">请检查邮箱收件箱（含垃圾邮件）。</p>
          )}
          <Button variant="outline" asChild className="w-full">
            <Link href="/login">
              <ArrowLeft className="size-4" /> 返回登录
            </Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email">账号邮箱</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="owner@xinglan.dev"
              disabled={loading}
            />
          </div>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={loading || !email}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />}
            {loading ? "正在提交…" : "发送重置链接"}
          </Button>
          <Button variant="ghost" asChild className="w-full">
            <Link href="/login">
              <ArrowLeft className="size-4" /> 返回登录
            </Link>
          </Button>
        </form>
      )}
    </div>
  );
}
