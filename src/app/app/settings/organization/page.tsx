"use client";

import { useEffect, useState } from "react";
import { Building2, Clock3, Globe2, Info, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, InfoGrid, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { DetailSkeleton, ErrorState } from "@/components/app/feedback";
import { ToneBadge } from "@/components/app/status-badge";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  activeMemberCount: number;
  productCount: number;
}

/** 常用时区：够覆盖大多数 SaaS 客户；不在列表里的当前值会额外补一项。 */
const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai（中国标准时间 UTC+8）" },
  { value: "Asia/Hong_Kong", label: "Asia/Hong_Kong（香港 UTC+8）" },
  { value: "Asia/Taipei", label: "Asia/Taipei（台北 UTC+8）" },
  { value: "Asia/Singapore", label: "Asia/Singapore（新加坡 UTC+8）" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo（东京 UTC+9）" },
  { value: "Asia/Seoul", label: "Asia/Seoul（首尔 UTC+9）" },
  { value: "Europe/London", label: "Europe/London（伦敦 UTC+0/+1）" },
  { value: "Europe/Berlin", label: "Europe/Berlin（柏林 UTC+1/+2）" },
  { value: "America/New_York", label: "America/New_York（纽约 UTC-5/-4）" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles（洛杉矶 UTC-8/-7）" },
  { value: "UTC", label: "UTC（协调世界时）" },
];

function timezoneOffsetLabel(timezone: string, at: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" });
    const part = formatter.formatToParts(at).find((item) => item.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

export default function OrganizationPage() {
  const { hasPermission, session, status: sessionStatus, refresh: refreshSession } = useSession();
  const canRead = hasPermission("org:read");
  const canWrite = hasPermission("org:write");
  const denied = sessionStatus === "ready" && !canRead;

  const { data, error, isLoading, isRefreshing, refresh } = useResource<Organization>(
    canRead ? "/api/v1/admin/organization" : null,
  );

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setTimezone(data.timezone);
  }, [data]);

  const dirty = Boolean(data) && (name !== data?.name || timezone !== data?.timezone);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const result = await apiRequest<{ notice?: string }>("/api/v1/admin/organization", {
        method: "PATCH",
        body: { name: name.trim(), timezone },
      });
      setNotice(result.notice ?? null);
      toast.success("组织设置已保存", { description: "新的时区只影响之后签发的授权与时间展示。" });
      refresh();
      refreshSession();
    } catch (err) {
      if (err instanceof ClientApiError) setFieldErrors(err.fieldErrors);
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (denied) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "组织设置" }]} title="组织设置" />
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          当前角色没有 org:read 权限，无法查看组织设置。
        </div>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "组织设置" }]} title="组织设置" />
        <DetailSkeleton />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "组织设置" }]} title="组织设置" />
        <ErrorState error={error} onRetry={refresh} />
      </div>
    );
  }

  const timezoneOptions = TIMEZONE_OPTIONS.some((item) => item.value === data?.timezone)
    ? TIMEZONE_OPTIONS
    : [...TIMEZONE_OPTIONS, { value: data?.timezone ?? "", label: data?.timezone ?? "" }];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "系统管理" }, { label: "组织设置" }]}
        title="组织设置"
        description="组织名称与授权时区。时区决定「一季度」「一年」这类自然月周期在哪个日历上计算，也决定后台所有时间展示。"
        meta={
          data ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <ToneBadge tone={data.status === "active" ? "success" : "neutral"}>{data.status === "active" ? "正常" : data.status}</ToneBadge>
              <ToneBadge tone="neutral" dot={false}>
                {data.memberCount} 位成员（{data.activeMemberCount} 位在职）
              </ToneBadge>
              <ToneBadge tone="neutral" dot={false}>
                {data.productCount} 个产品
              </ToneBadge>
            </div>
          ) : null
        }
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /> 刷新
          </Button>
        }
      />

      {notice ? (
        <div className="flex items-start gap-2 rounded-xl border border-info/30 bg-info/5 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
          <span>{notice}</span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Section
          title="基本信息"
          description="组织名称会显示在侧边栏顶部与导出的文件中。"
          contentClassName="p-0"
        >
          <form onSubmit={submit} className="space-y-4 p-4">
            <FormError message={formError} />

            <FormField label="组织名称" htmlFor="org-name" required error={fieldErrors.name} hint="2–60 个字符，展示在侧边栏与登录后的欢迎语中。">
              <Input
                id="org-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!canWrite || submitting}
                maxLength={60}
                required
              />
            </FormField>

            <FormField
              label="组织标识（slug）"
              htmlFor="org-slug"
              hint="用于 API 与对外链接，创建后不可修改。"
            >
              <Input id="org-slug" value={data?.slug ?? ""} readOnly disabled className="font-mono text-xs" />
            </FormField>

            <FormField
              label="授权时区"
              required
              error={fieldErrors.timezone}
              hint="自然月周期（一季度 3 个月、一年 12 个月）按此时区的日历计算；月末会钳制到当月最后一天。"
              actions={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock3 className="size-3" />
                      当前偏移 {timezoneOffsetLabel(timezone || data?.timezone || "UTC", new Date())}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>偏移随夏令时变化，展示的是此刻的时区偏移。</TooltipContent>
                </Tooltip>
              }
            >
              <Select value={timezone} onValueChange={setTimezone} disabled={!canWrite || submitting}>
                <SelectTrigger id="org-timezone" className="w-full">
                  <SelectValue placeholder="选择时区" />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {canWrite ? (
                <Button type="submit" size="sm" disabled={submitting || !dirty}>
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  保存修改
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button size="sm" disabled>
                        <Save className="size-3.5" /> 保存修改
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>当前角色没有 org:write 权限</TooltipContent>
                </Tooltip>
              )}
              {dirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setName(data?.name ?? "");
                    setTimezone(data?.timezone ?? "");
                    setFormError(null);
                  }}
                  disabled={submitting}
                >
                  撤销改动
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">没有未保存的改动</span>
              )}
            </div>
          </form>
        </Section>

        <div className="space-y-4">
          <Section title="组织档案" contentClassName="p-4">
            <InfoGrid
              columns={2}
              items={[
                { label: "组织 ID", value: data?.id ?? "", mono: true },
                { label: "状态", value: data?.status === "active" ? "正常" : data?.status ?? "" },
                { label: "创建时间", value: data ? formatDateTime(data.createdAt, data.timezone) : "" },
                { label: "最近更新", value: data ? formatDateTime(data.updatedAt, data.timezone) : "" },
              ]}
            />
          </Section>

          <Section title="时间展示示例" description="后台所有时间都会换算到组织时区后再展示。" contentClassName="p-4">
            <div className="space-y-2 text-xs">
              {[
                { label: "时区", value: data?.timezone ?? "" },
                { label: "完整时间", value: data ? formatDateTime(new Date().toISOString(), data.timezone) : "" },
                {
                  label: "自然月示例",
                  value: "2026-01-31 起算 + 3 个月 → 2026-04-30（月末钳制）",
                },
              ].map((item) => (
                <div key={item.label} className="flex items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                  <span className="shrink-0 text-muted-foreground">{item.label}</span>
                  <span className="text-right font-medium text-foreground">{item.value}</span>
                </div>
              ))}
            </div>
            <FormHint>
              当前会话时区：{session?.organization.timezone ?? "未加载"}。修改时区后侧边栏与列表页的时间展示会立即更新。
            </FormHint>
          </Section>

          <Section title="相关入口" contentClassName="p-2">
            <div className="space-y-1">
              {[
                { href: "/app/settings/members", label: "管理员与角色", icon: Building2 },
                { href: "/app/settings/system", label: "系统设置", icon: Globe2 },
              ].map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <item.icon className="size-3.5" />
                  {item.label}
                </a>
              ))}
            </div>
          </Section>
        </div>
      </div>

      <FormHint>
        修改时区不会改变已签发授权的期限快照；仅影响后续签发的授权与后台时间展示。
      </FormHint>
    </div>
  );
}
