"use client";

import { useEffect, useMemo, useState } from "react";
import { Info, Loader2, RefreshCw, RotateCcw, Save, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, InfoGrid, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge } from "@/components/app/status-badge";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SettingField {
  key: string;
  type: "integer" | "boolean";
  label: string;
  description: string;
  defaultValue: number | boolean;
  min?: number;
  max?: number;
  unit?: string;
}

interface SettingsResponse {
  settings: Record<string, unknown>;
  overrides: Record<string, unknown>;
  effectiveSettings: Record<string, unknown>;
  defaults: Record<string, unknown>;
  fields: SettingField[];
  updatedAt: string | null;
}

type Draft = Record<string, number | boolean | undefined>;

function effectiveValueOf(field: SettingField, source: Record<string, unknown> | undefined): number | boolean {
  const raw = source?.[field.key];
  if (field.type === "boolean") return Boolean(raw ?? field.defaultValue);
  const value = Number(raw ?? field.defaultValue);
  return Number.isFinite(value) ? value : Number(field.defaultValue);
}

export default function SystemSettingsPage() {
  const { hasPermission, status: sessionStatus } = useSession();
  const canRead = hasPermission("settings:read");
  const canWrite = hasPermission("settings:write");
  const denied = sessionStatus === "ready" && !canRead;

  const { data, error, isLoading, isRefreshing, refresh } = useResource<SettingsResponse>(
    canRead ? "/api/v1/admin/settings" : null,
  );

  const [draft, setDraft] = useState<Draft>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    const next: Draft = {};
    for (const field of data.fields) next[field.key] = effectiveValueOf(field, data.effectiveSettings);
    setDraft(next);
    setFieldErrors({});
    setFormError(null);
  }, [data]);

  const changed = useMemo(() => {
    if (!data) return {} as Record<string, number | boolean>;
    const result: Record<string, number | boolean> = {};
    for (const field of data.fields) {
      const current = effectiveValueOf(field, data.effectiveSettings);
      const next = draft[field.key];
      if (next !== undefined && next !== current) result[field.key] = next;
    }
    return result;
  }, [data, draft]);

  const changedCount = Object.keys(changed).length;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (changedCount === 0) return;
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const result = await apiRequest<{ changed: string[] }>("/api/v1/admin/settings", {
        method: "PATCH",
        body: changed,
      });
      toast.success("系统设置已保存", {
        description: `已更新 ${result.changed?.length ?? changedCount} 项：${(result.changed ?? Object.keys(changed)).join("、")}`,
      });
      refresh();
    } catch (err) {
      if (err instanceof ClientApiError) setFieldErrors(err.fieldErrors);
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const resetField = (field: SettingField) => {
    setDraft((prev) => ({ ...prev, [field.key]: field.defaultValue }));
  };

  if (denied) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "系统设置" }]} title="系统设置" />
        <EmptyState
          icon={<ShieldAlert className="size-5" />}
          title="没有查看系统设置的权限"
          description="需要 settings:read 权限，接口同样会拒绝这次请求。"
        />
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "系统设置" }]} title="系统设置" />
        <DetailSkeleton />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-3">
        <PageHeader breadcrumbs={[{ label: "系统管理" }, { label: "系统设置" }]} title="系统设置" />
        <ErrorState error={error} onRetry={refresh} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "系统管理" }, { label: "系统设置" }]}
        title="系统设置"
        description="日志保留、会话时长、Webhook 重试等运行参数。只接受白名单键，越界值会被接口拒绝并返回字段级错误。"
        meta={
          data ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <ToneBadge tone="neutral" dot={false}>
                白名单 {data.fields.length} 项
              </ToneBadge>
              <ToneBadge tone={Object.keys(data.overrides ?? {}).length > 0 ? "info" : "neutral"} dot={false}>
                已覆盖 {Object.keys(data.overrides ?? {}).length} 项
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Section
          title="运行参数"
          description="布尔项用 Switch 即时表达开关语义，数值项按范围校验；保存后立即生效。"
          contentClassName="p-0"
        >
          <form onSubmit={submit} className="divide-y divide-border">
            <div className="space-y-4 p-4">
              <FormError message={formError} />
              {data?.fields.map((field) => {
                const value = draft[field.key];
                const isOverride = Object.prototype.hasOwnProperty.call(data.overrides ?? {}, field.key);
                const isDirty = value !== undefined && value !== effectiveValueOf(field, data.effectiveSettings);
                return (
                  <div key={field.key} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          {field.label}
                          <span className="font-mono text-[10px] text-muted-foreground">{field.key}</span>
                          {isOverride ? (
                            <ToneBadge tone="info" dot={false} className="text-[10px]">
                              已覆盖
                            </ToneBadge>
                          ) : (
                            <ToneBadge tone="neutral" dot={false} className="text-[10px]">
                              默认值
                            </ToneBadge>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {isDirty ? <ToneBadge tone="warning" dot={false}>未保存</ToneBadge> : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => resetField(field)}
                              disabled={!canWrite || submitting}
                              aria-label={`把 ${field.label} 重置为默认值`}
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>重置为默认值 {String(field.defaultValue)}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    <div className="mt-3">
                      {field.type === "boolean" ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            id={`setting-${field.key}`}
                            checked={Boolean(value)}
                            onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, [field.key]: checked }))}
                            disabled={!canWrite || submitting}
                          />
                          <label htmlFor={`setting-${field.key}`} className="text-xs text-muted-foreground">
                            {Boolean(value) ? "已开启" : "已关闭"}
                          </label>
                        </div>
                      ) : (
                        <FormField
                          label=""
                          htmlFor={`setting-${field.key}`}
                          error={fieldErrors[field.key]}
                          className="space-y-1"
                        >
                          <div className="flex items-center gap-2">
                            <Input
                              id={`setting-${field.key}`}
                              type="number"
                              inputMode="numeric"
                              value={value === undefined ? "" : String(value)}
                              min={field.min}
                              max={field.max}
                              onChange={(event) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  [field.key]: event.target.value === "" ? undefined : Number(event.target.value),
                                }))
                              }
                              disabled={!canWrite || submitting}
                              className="h-8 w-32 tabular text-xs"
                            />
                            {field.unit ? <span className="text-xs text-muted-foreground">{field.unit}</span> : null}
                            <span className="text-[11px] text-muted-foreground">
                              范围 {field.min}–{field.max}，默认 {String(field.defaultValue)}
                            </span>
                          </div>
                        </FormField>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 p-4">
              {canWrite ? (
                <Button type="submit" size="sm" disabled={submitting || changedCount === 0}>
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  保存 {changedCount > 0 ? `${changedCount} 项改动` : "设置"}
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button size="sm" disabled>
                        <Save className="size-3.5" /> 保存设置
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>当前角色没有 settings:write 权限</TooltipContent>
                </Tooltip>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submitting || changedCount === 0}
                onClick={() => {
                  if (!data) return;
                  const next: Draft = {};
                  for (const field of data.fields) next[field.key] = effectiveValueOf(field, data.effectiveSettings);
                  setDraft(next);
                  setFieldErrors({});
                  setFormError(null);
                }}
              >
                撤销改动
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {changedCount > 0 ? `待保存：${Object.keys(changed).join("、")}` : "没有未保存的改动"}
              </span>
            </div>
          </form>
        </Section>

        <div className="space-y-4">
          <Section title="生效值快照" description="合并默认值后的最终取值。" contentClassName="p-4">
            <div className="space-y-1.5 text-xs">
              {data?.fields.map((field) => (
                <div
                  key={field.key}
                  className="flex items-center justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0 last:pb-0"
                >
                  <span className="text-muted-foreground">{field.label}</span>
                  <span className="font-mono font-medium text-foreground">
                    {String(effectiveValueOf(field, data.effectiveSettings))}
                    {field.unit ? ` ${field.unit}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="审计信息" contentClassName="p-4">
            <InfoGrid
              columns={2}
              items={[
                { label: "最近更新", value: data?.updatedAt ? formatDateTime(data.updatedAt, "Asia/Shanghai") : "从未修改" },
                { label: "覆盖项", value: String(Object.keys(data?.overrides ?? {}).length), mono: true },
              ]}
            />
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 px-2.5 py-2 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
              <span>每次保存都会写入操作审计（settings.update），记录改动前后的键值。</span>
            </div>
          </Section>

          <Section title="相关入口" contentClassName="p-2">
            <div className="space-y-1">
              {[
                { href: "/app/security/audit-logs", label: "操作审计" },
                { href: "/app/security/verification-logs", label: "验证日志" },
                { href: "/app/settings/organization", label: "组织设置" },
              ].map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <SlidersHorizontal className="size-3.5" />
                  {item.label}
                </a>
              ))}
            </div>
          </Section>
        </div>
      </div>

      <FormHint>改动只影响后续行为：缩短日志保留天数不会立刻删除历史记录，清理由后台任务按新阈值执行。</FormHint>
    </div>
  );
}
