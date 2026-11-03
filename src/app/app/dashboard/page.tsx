"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  FileKey,
  Plus,
  RefreshCw,
  ShieldAlert,
  Waypoints,
} from "lucide-react";
import { PageHeader, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, EmptyState } from "@/components/app/feedback";
import { BarChart, Sparkline, StatusBars } from "@/components/app/charts";
import { EffectiveStatusBadge, type Tone } from "@/components/app/status-badge";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { EFFECTIVE_STATUS_LABEL, type EffectiveStatus } from "@/lib/domain/effective-status";
import { formatDateTime, formatRelative } from "@/lib/format";

interface DashboardData {
  generatedAt: string;
  kpis: {
    licensesTotal: number;
    licensesActive: number;
    expiringIn30Days: number;
    suspended: number;
    revoked: number;
    activeDevices: number;
    activationsLast7Days: number;
    verification24h: { total: number; failed: number; successRate: number | null; avgLatencyMs: number };
    auditEvents7Days: number;
  };
  statusDistribution: Array<{ status: string; total: number }>;
  activationSeries: Array<{ date: string; total: number }>;
  verificationSeries: Array<{ date: string; total: number; failed: number }>;
  topProducts: Array<{ id: string; name: string; code: string; type: string; licenses: number; devices: number }>;
  expiringSoon: Array<{ id: string; productName: string; customerName: string; expiresAt: string | null; adminStatus: string }>;
  recentAudit: Array<{ id: string; action: string; resourceType: string; resourceId: string | null; actorName: string; createdAt: string }>;
}

const STATUS_TONE: Record<string, Tone> = {
  active: "success",
  pending: "info",
  suspended: "warning",
  expired: "danger",
  revoked: "danger",
  cancelled: "neutral",
  draft: "neutral",
  not_yet_valid: "info",
  activation_window_expired: "warning",
  product_disabled: "danger",
};

export default function DashboardPage() {
  const { session, hasPermission } = useSession();
  const { data, error, isLoading, isRefreshing, refresh } = useResource<DashboardData>(
    hasPermission("dashboard:read") ? "/api/v1/admin/dashboard" : null,
  );

  const statusItems = useMemo(
    () =>
      (data?.statusDistribution ?? [])
        .map((item) => ({
          label: EFFECTIVE_STATUS_LABEL[item.status as EffectiveStatus] ?? item.status,
          value: item.total,
          tone: STATUS_TONE[item.status] ?? "neutral",
        }))
        .filter((item) => item.value > 0),
    [data],
  );

  if (!hasPermission("dashboard:read")) {
    return (
      <EmptyState
        icon={<ShieldAlert className="size-5" />}
        title="当前角色无权查看工作台"
        description="请联系组织所有者调整你的角色，或从左侧导航进入可访问的页面。"
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={`你好，${session?.user.displayName ?? ""}`}
        description="授权、设备、验证流量的实时概览。所有数字来自数据库聚合，点击卡片可进入对应筛选列表。"
        meta={
          <>
            <Badge variant="outline" className="status-brand">
              {session?.organization.name}
            </Badge>
            <span className="text-xs text-muted-foreground">
              统计时间 {data ? formatDateTime(data.generatedAt) : "—"} · 时区 {session?.organization.timezone}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing || isLoading}>
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} /> 刷新
            </Button>
            {hasPermission("license:issue") ? (
              <Button size="sm" asChild>
                <Link href="/app/licenses?action=issue">
                  <Plus className="size-3.5" /> 签发授权
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {!error ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              loading={isLoading}
              label="有效授权"
              value={data?.kpis.licensesActive}
              suffix={`/ ${data?.kpis.licensesTotal ?? 0} 份总数`}
              hint="管理状态与有效期共同判定"
              icon={<BadgeCheck className="size-4" />}
              href="/app/licenses?effectiveStatus=active"
              spark={data?.verificationSeries.map((item) => item.total) ?? []}
              tone="success"
            />
            <KpiCard
              loading={isLoading}
              label="30 天内到期"
              value={data?.kpis.expiringIn30Days}
              suffix="份授权"
              hint="建议提前 7 天触达客户续费"
              icon={<AlertTriangle className="size-4" />}
              href="/app/licenses?expiringInDays=30"
              tone="warning"
              badge={data && data.kpis.expiringIn30Days > 0 ? "需要跟进" : undefined}
            />
            <KpiCard
              loading={isLoading}
              label="活跃设备"
              value={data?.kpis.activeDevices}
              suffix="台绑定中"
              hint={`近 7 天新增激活 ${data?.kpis.activationsLast7Days ?? 0} 次`}
              icon={<Waypoints className="size-4" />}
              href="/app/devices"
              tone="brand"
            />
            <KpiCard
              loading={isLoading}
              label="24 小时验证成功率"
              value={
                data?.kpis.verification24h.successRate === null || data?.kpis.verification24h.successRate === undefined
                  ? undefined
                  : Math.round(data.kpis.verification24h.successRate * 1000) / 10
              }
              suffix="%"
              hint={`平均延迟 ${data?.kpis.verification24h.avgLatencyMs ?? 0} ms · ${data?.kpis.verification24h.failed ?? 0} 次失败`}
              icon={<Activity className="size-4" />}
              href="/app/security/verification-logs"
              tone="info"
            />
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <Section
              className="flex flex-col xl:col-span-2"
              contentClassName="flex flex-1 flex-col"
              title="近 14 天授权验证量"
              description="来自 api_request_logs；红色为失败请求（4xx / 5xx）"
              actions={
                <Button variant="ghost" size="xs" asChild>
                  <Link href="/app/security/verification-logs">
                    查看日志 <ArrowRight className="size-3" />
                  </Link>
                </Button>
              }
            >
              {isLoading ? (
                <Skeleton className="h-[140px] w-full" />
              ) : (
                <BarChart
                  data={(data?.verificationSeries ?? []).map((item) => ({
                    label: item.date,
                    value: item.total,
                    secondary: item.failed,
                  }))}
                  valueLabel="验证请求"
                  tone="brand"
                  className="flex-1"
                />
              )}
              <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-primary" aria-hidden /> 成功请求
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-destructive" aria-hidden /> 失败请求
                </span>
                <span className="ml-auto">近 14 天审计事件 {data?.kpis.auditEvents7Days ?? 0} 条</span>
              </div>
            </Section>

            <Section title="授权有效状态分布" description="有效状态由服务端计算，不写入 admin_status">
              {isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-6 w-full" />
                  ))}
                </div>
              ) : statusItems.length === 0 ? (
                <EmptyState title="还没有授权数据" description="签发第一份授权后，这里会显示状态分布。" />
              ) : (
                <StatusBars items={statusItems} total={data?.kpis.licensesTotal ?? 0} />
              )}
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
                  <p className="text-muted-foreground">已暂停</p>
                  <p className="tabular text-base font-semibold text-foreground">{data?.kpis.suspended ?? 0}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
                  <p className="text-muted-foreground">已撤销</p>
                  <p className="tabular text-base font-semibold text-foreground">{data?.kpis.revoked ?? 0}</p>
                </div>
              </div>
            </Section>
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <Section
              className="xl:col-span-2"
              title="即将到期"
              description="按到期时间升序，仅包含待激活 / 已激活授权"
              actions={
                <Button variant="ghost" size="xs" asChild>
                  <Link href="/app/licenses?expiringInDays=30">
                    全部 <ArrowRight className="size-3" />
                  </Link>
                </Button>
              }
              contentClassName="p-0"
            >
              {isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                  ))}
                </div>
              ) : (data?.expiringSoon.length ?? 0) === 0 ? (
                <div className="p-4">
                  <EmptyState title="30 天内没有到期授权" description="客户续费节奏健康。" />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {data?.expiringSoon.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/app/licenses/${item.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{item.customerName}</p>
                          <p className="truncate text-xs text-muted-foreground">{item.productName}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="tabular text-xs text-foreground">{item.expiresAt ? formatDateTime(item.expiresAt) : "永久"}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {item.expiresAt ? formatRelative(item.expiresAt) : ""}
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="产品线概览" description="按有效授权数量排序" contentClassName="p-0">
              {isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {data?.topProducts.map((product) => (
                    <li key={product.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Building2 className="size-3.5" aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">{product.name}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{product.code}</p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-xs">
                        <p className="tabular text-foreground">{product.licenses} 份授权</p>
                        <p className="tabular text-muted-foreground">{product.devices} 台设备</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-border px-4 py-2">
                <Button variant="ghost" size="xs" asChild>
                  <Link href="/app/products">
                    管理产品 <ArrowRight className="size-3" />
                  </Link>
                </Button>
              </div>
            </Section>
          </div>

          <Section title="最近操作审计" description="所有授权状态变更、续费与解绑都会留痕" contentClassName="p-0">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data?.recentAudit.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileKey className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate font-mono text-xs text-foreground">{entry.action}</span>
                      <span className="hidden truncate text-xs text-muted-foreground sm:inline">{entry.actorName}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}

function KpiCard({
  label,
  value,
  suffix,
  hint,
  icon,
  href,
  spark,
  tone = "brand",
  badge,
  loading,
}: {
  label: string;
  value?: number;
  suffix?: string;
  hint?: string;
  icon: React.ReactNode;
  href: string;
  spark?: number[];
  tone?: Tone;
  badge?: string;
  loading: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-3.5 shadow-xs transition-colors hover:border-primary/40 hover:bg-primary/[0.02] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary">
          {icon}
        </span>
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="flex items-end gap-1.5">
          <span className="tabular text-2xl leading-none font-semibold text-foreground">
            {value === undefined ? "—" : value.toLocaleString("zh-CN")}
          </span>
          {suffix ? <span className="pb-0.5 text-xs text-muted-foreground">{suffix}</span> : null}
        </div>
      )}
      {badge ? (
        <Badge variant="outline" className="w-fit status-warning">
          {badge}
        </Badge>
      ) : null}
      {spark && spark.length > 1 ? <Sparkline values={spark} tone={tone} /> : null}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </Link>
  );
}
