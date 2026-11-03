"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  CalendarClock,
  Copy,
  FileKey,
  History,
  Laptop,
  ListChecks,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import { PageHeader, InfoGrid, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import {
  ActivationStatusBadge,
  AdminStatusBadge,
  EffectiveStatusBadge,
  ToneBadge,
} from "@/components/app/status-badge";
import { CopyButton } from "@/components/app/copy-button";
import { LicenseRowActions } from "@/components/licensing/license-row-actions";
import { LicenseFeatureDialog } from "@/components/licensing/license-feature-dialog";
import { ActivationActions } from "@/components/licensing/activation-actions";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { durationLabel, formatDate, formatDateTime, formatRelative } from "@/lib/format";
import type { LicenseRow } from "@/lib/types";

interface DetailResponse {
  license: {
    id: string;
    adminStatus: LicenseRow["adminStatus"];
    effective: LicenseRow["effective"];
    duration: { unit: "day" | "month" | "lifetime"; value: number };
    startPolicy: string;
    timezone: string;
    startsAt: string | null;
    expiresAt: string | null;
    activationDeadlineAt: string | null;
    maxDevices: number;
    activeDevices: number;
    maxActivationCount: number | null;
    activationCount: number;
    maxSubjects: number | null;
    refundActivationOnRelease: boolean;
    offlineAllowed: boolean;
    offlineGraceSeconds: number;
    featureSnapshot: Record<string, unknown>;
    /** 权限快照版本：覆盖值变更时服务端自增，客户端心跳靠它判断要不要重拉（P1-3）。 */
    entitlementsVersion: number;
    features: Array<{ code: string; value: unknown; updatedAt: string }>;
    notes: string | null;
    externalOrderId: string | null;
    createdAt: string;
    createdBy: { id: string; display_name: string; email: string } | null;
    product: { id: string; name: string; code: string; type: string; status: string };
    customer: { id: string; name: string; email: string | null; company: string | null };
    plan: { id: string; name: string; code: string } | null;
    key: { id: string; mask: string; last4: string; status: string; firstRedeemedAt: string | null; createdAt: string } | null;
    keys: Array<{ id: string; mask: string; status: string; createdAt: string; revokedAt: string | null; firstRedeemedAt: string | null }>;
  };
  renewals: Array<{
    id: string;
    duration: { unit: "day" | "month" | "lifetime"; value: number };
    previousExpiresAt: string | null;
    renewalStartsAt: string;
    newExpiresAt: string | null;
    mode: string;
    paymentRef: string | null;
    notes: string | null;
    createdAt: string;
  }>;
  activations: Array<{
    id: string;
    status: string;
    deviceId: string;
    deviceName: string | null;
    platform: string;
    instanceId: string;
    clientVersion: string | null;
    activatedAt: string;
    lastSeenAt: string;
    releasedAt: string | null;
    revokedAt: string | null;
    lastIp: string | null;
  }>;
  events: Array<{ id: string; activationId: string; type: string; actorType: string; createdAt: string; details: unknown }>;
  auditLogs: Array<{
    id: string;
    action: string;
    actorType: string;
    actorId: string | null;
    before: unknown;
    after: unknown;
    createdAt: string;
  }>;
}

const MODE_LABEL: Record<string, string> = {
  append: "顺延（从原到期时间）",
  from_now: "重新起算（从当前时间）",
  manual_adjustment: "人工调整",
};

export default function LicenseDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { data, error, isLoading, refresh } = useResource<DetailResponse>(id ? `/api/v1/admin/licenses/${id}` : null);
  const { session, hasPermission } = useSession();
  const [tab, setTab] = useState("overview");
  const [featureDialogOpen, setFeatureDialogOpen] = useState(false);

  const license = data?.license;
  // 能签发授权的人才能调权限位（与后端 license:issue 一致），避免按钮点了才 403。
  const canEditFeatures = hasPermission("license:issue") && Boolean(license?.product?.id);

  const rowForActions = useMemo<LicenseRow | null>(() => {
    if (!license) return null;
    return {
      id: license.id,
      adminStatus: license.adminStatus,
      effective: license.effective,
      product: license.product,
      customer: { id: license.customer.id, name: license.customer.name, email: license.customer.email },
      duration: license.duration,
      startsAt: license.startsAt,
      expiresAt: license.expiresAt,
      activationDeadlineAt: license.activationDeadlineAt,
      maxDevices: license.maxDevices,
      activeDevices: license.activeDevices,
      activationCount: license.activationCount,
      maxActivationCount: license.maxActivationCount,
      keyMask: license.key?.mask ?? null,
      createdAt: license.createdAt,
      timezone: license.timezone,
    };
  }, [license]);

  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (isLoading || !license) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const activationColumns: DataColumn<DetailResponse["activations"][number]>[] = [
    {
      key: "device",
      header: "设备",
      cell: (row) => (
        <div className="flex items-center gap-2">
          <Laptop className="size-3.5 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-sm text-foreground">{row.deviceName ?? "未命名设备"}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{row.instanceId}</p>
          </div>
        </div>
      ),
      width: "240px",
    },
    { key: "platform", header: "平台", cell: (row) => <span className="text-xs text-muted-foreground">{row.platform}</span> },
    {
      key: "status",
      header: "状态",
      cell: (row) => <ActivationStatusBadge status={row.status} />,
    },
    {
      key: "activated",
      header: "绑定时间",
      cell: (row) => <span className="text-[11px] text-muted-foreground">{formatDateTime(row.activatedAt, license.timezone)}</span>,
    },
    {
      key: "lastSeen",
      header: "最后在线",
      cell: (row) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] text-muted-foreground">{formatRelative(row.lastSeenAt)}</span>
          </TooltipTrigger>
          <TooltipContent>
            {formatDateTime(row.lastSeenAt, license.timezone)}
            <span className="ml-1 text-muted-foreground">（最后在线 ≠ 当前在线）</span>
          </TooltipContent>
        </Tooltip>
      ),
    },
    { key: "ip", header: "IP", cell: (row) => <span className="font-mono text-[11px] text-muted-foreground">{row.lastIp ?? "—"}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (row) => <ActivationActions activation={row} onChanged={refresh} compact />,
      width: "60px",
    },
  ];

  const renewalColumns: DataColumn<DetailResponse["renewals"][number]>[] = [
    { key: "duration", header: "续费周期", cell: (row) => <span className="text-xs">{durationLabel(row.duration)}</span> },
    {
      key: "mode",
      header: "起算方式",
      cell: (row) => (
        <ToneBadge tone={row.mode === "append" ? "info" : "warning"} dot={false}>
          {MODE_LABEL[row.mode] ?? row.mode}
        </ToneBadge>
      ),
    },
    {
      key: "previous",
      header: "原到期",
      cell: (row) => <span className="tabular text-[11px] text-muted-foreground">{formatDateTime(row.previousExpiresAt, license.timezone)}</span>,
    },
    {
      key: "new",
      header: "新到期",
      cell: (row) => <span className="tabular text-[11px] text-foreground">{formatDateTime(row.newExpiresAt, license.timezone)}</span>,
    },
    { key: "payment", header: "支付引用", cell: (row) => <span className="font-mono text-[11px] text-muted-foreground">{row.paymentRef ?? "—"}</span> },
    { key: "at", header: "操作时间", cell: (row) => <span className="text-[11px] text-muted-foreground">{formatDateTime(row.createdAt, license.timezone)}</span> },
  ];

  const featureRows = Object.entries(license.featureSnapshot ?? {}).map(([code, value]) => ({ code, value }));
  const overrideMap = new Map(license.features.map((row) => [row.code, row.value]));
  const featureColumns: DataColumn<{ code: string; value: unknown }>[] = [
    { key: "code", header: "功能编码", cell: (row) => <span className="font-mono text-xs">{row.code}</span> },
    {
      key: "value",
      header: "生效值（快照）",
      cell: (row) => (
        <span className="font-mono text-xs text-foreground">
          {typeof row.value === "object" ? JSON.stringify(row.value) : String(row.value)}
        </span>
      ),
    },
    {
      key: "source",
      header: "来源",
      cell: (row) =>
        overrideMap.has(row.code) ? (
          <ToneBadge tone="brand" dot={false}>授权覆盖</ToneBadge>
        ) : (
          <ToneBadge tone="neutral" dot={false}>套餐 / 产品默认</ToneBadge>
        ),
    },
  ];

  const eventColumns: DataColumn<DetailResponse["events"][number]>[] = [
    { key: "type", header: "事件", cell: (row) => <span className="font-mono text-xs">{row.type}</span> },
    { key: "actor", header: "触发方", cell: (row) => <span className="text-xs text-muted-foreground">{row.actorType}</span> },
    {
      key: "details",
      header: "详情",
      cell: (row) => (
        <span className="line-clamp-1 max-w-[420px] font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(row.details)}
        </span>
      ),
    },
    { key: "at", header: "时间", cell: (row) => <span className="text-[11px] text-muted-foreground">{formatDateTime(row.createdAt, license.timezone)}</span> },
  ];

  const auditColumns: DataColumn<DetailResponse["auditLogs"][number]>[] = [
    { key: "action", header: "操作", cell: (row) => <span className="font-mono text-xs">{row.action}</span> },
    { key: "actor", header: "操作者类型", cell: (row) => <span className="text-xs text-muted-foreground">{row.actorType}</span> },
    {
      key: "change",
      header: "变更摘要",
      cell: (row) => (
        <span className="line-clamp-1 max-w-[420px] font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(row.after ?? row.before ?? {})}
        </span>
      ),
    },
    { key: "at", header: "时间", cell: (row) => <span className="text-[11px] text-muted-foreground">{formatDateTime(row.createdAt, license.timezone)}</span> },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[
          { label: "业务管理" },
          { label: "授权管理", href: "/app/licenses" },
          { label: license.customer.name },
        ]}
        title={license.customer.name}
        description={`${license.product.name} · ${durationLabel(license.duration)} · ${license.plan?.name ?? "自定义策略"}`}
        meta={
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              有效状态
              <EffectiveStatusBadge status={license.effective.status} />
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              管理状态
              <AdminStatusBadge status={license.adminStatus} />
            </span>
            <span className="text-xs text-muted-foreground">{license.effective.reason}</span>
            {license.effective.status === "active" && !license.effective.canActivate ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToneBadge tone="warning">不可新增激活</ToneBadge>
                </TooltipTrigger>
                <TooltipContent>{license.effective.reason}</TooltipContent>
              </Tooltip>
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/licenses">
                <ArrowLeft className="size-3.5" /> 返回列表
              </Link>
            </Button>
            {rowForActions ? <LicenseRowActions license={rowForActions} onChanged={refresh} /> : null}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="到期时间" value={license.expiresAt ? formatDate(license.expiresAt, license.timezone) : "永久"} hint={license.startsAt ? `开始于 ${formatDate(license.startsAt, license.timezone)}` : "首次激活时起算"} icon={<CalendarClock className="size-4" />} />
        <StatCard label="设备名额" value={`${license.activeDevices} / ${license.maxDevices}`} hint={`累计激活 ${license.activationCount}${license.maxActivationCount ? ` / ${license.maxActivationCount}` : ""} 次`} icon={<Laptop className="size-4" />} />
        <StatCard label="兑换码" value={license.key?.mask ?? "未生成"} hint={license.key?.firstRedeemedAt ? `首次兑换 ${formatRelative(license.key.firstRedeemedAt)}` : "尚未兑换"} icon={<FileKey className="size-4" />} mono />
        <StatCard label="离线授权" value={license.offlineAllowed ? "已允许" : "不允许"} hint={license.offlineAllowed ? `宽限 ${Math.round(license.offlineGraceSeconds / 86400)} 天` : "仅支持在线校验"} icon={<ShieldCheck className="size-4" />} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="activations">激活设备 ({license.activeDevices})</TabsTrigger>
          <TabsTrigger value="features">功能权限 ({featureRows.length})</TabsTrigger>
          <TabsTrigger value="renewals">续费记录 ({data?.renewals.length ?? 0})</TabsTrigger>
          <TabsTrigger value="events">验证日志 ({data?.events.length ?? 0})</TabsTrigger>
          <TabsTrigger value="audit">操作历史 ({data?.auditLogs.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3 space-y-3">
          <Section title="授权概览" description="周期按授权快照时区计算，修改组织时区不会改变已签发授权">
            <InfoGrid
              items={[
                { label: "License ID", value: license.id, mono: true },
                {
                  label: "产品",
                  value: (
                    <Link href={`/app/products/${license.product.id}`} className="text-primary hover:underline">
                      {license.product.name}
                    </Link>
                  ),
                  hint: license.product.code,
                },
                {
                  label: "客户",
                  value: (
                    <Link href={`/app/customers/${license.customer.id}`} className="text-primary hover:underline">
                      {license.customer.name}
                    </Link>
                  ),
                  hint: license.customer.email ?? undefined,
                },
                { label: "套餐", value: license.plan?.name ?? "自定义（未基于套餐）", hint: license.plan?.code },
                { label: "授权周期", value: durationLabel(license.duration), hint: `时区 ${license.timezone}` },
                { label: "起算方式", value: license.startPolicy === "fixed_start" ? "固定开始时间" : "首次激活起算" },
                { label: "开始时间", value: license.startsAt ? formatDateTime(license.startsAt, license.timezone) : "首次激活时写入" },
                { label: "到期时间", value: license.expiresAt ? formatDateTime(license.expiresAt, license.timezone) : "永久（仍可暂停/撤销）" },
                {
                  label: "首次激活截止",
                  value: license.activationDeadlineAt ? formatDateTime(license.activationDeadlineAt, license.timezone) : "不限制",
                  hint: license.effective.status === "activation_window_expired" ? "已超时，不能激活" : undefined,
                },
                { label: "最大设备数", value: `${license.maxDevices} 台` },
                { label: "最大账号数", value: license.maxSubjects ? `${license.maxSubjects} 个` : "不限制" },
                { label: "解绑返还激活次数", value: license.refundActivationOnRelease ? "是" : "否（默认）" },
                { label: "外部订单号", value: license.externalOrderId ?? "—", mono: true },
                { label: "创建时间", value: formatDateTime(license.createdAt, license.timezone), hint: license.createdBy ? `创建人 ${license.createdBy.display_name}` : undefined },
                { label: "备注", value: license.notes ?? "—" },
              ]}
            />
          </Section>

          <Section
            title="兑换码"
            description="服务端只保存 HMAC-SHA-256 哈希，任何页面都不会再次显示明文"
            actions={
              license.key ? <CopyButton value={license.key.mask} label="复制脱敏兑换码" tooltip="复制脱敏显示值" /> : null
            }
          >
            {license.key ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <code className="font-mono text-sm text-foreground">{license.key.mask}</code>
                  <ToneBadge tone={license.key.status === "active" ? "success" : "neutral"}>
                    {license.key.status === "active" ? "有效" : "已停用"}
                  </ToneBadge>
                  <span className="text-xs text-muted-foreground">
                    {license.key.firstRedeemedAt ? `首次兑换于 ${formatDateTime(license.key.firstRedeemedAt, license.timezone)}` : "尚未兑换"}
                  </span>
                </div>
                {license.keys.length > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    历史兑换码 {license.keys.length - 1} 个，均已停用。需要重新交付请使用「重发兑换码」。
                  </p>
                ) : null}
              </div>
            ) : (
              <EmptyState
                title="该授权是草稿，尚未生成兑换码"
                description="发布草稿或使用「重发兑换码」即可生成。"
                icon={<FileKey className="size-5" />}
              />
            )}
          </Section>
        </TabsContent>

        <TabsContent value="activations" className="mt-3">
          <Section
            title="激活设备"
            description="解绑释放设备名额；禁用设备不释放名额但阻止校验。最后在线时间不等于当前在线。"
            contentClassName="p-0"
          >
            <DataTable
              columns={activationColumns}
              rows={data?.activations ?? []}
              rowKey={(row) => row.id}
              dense
              empty={<EmptyState title="还没有设备激活" description="客户使用兑换码激活后会出现在这里。" icon={<Laptop className="size-5" />} />}
            />
          </Section>
        </TabsContent>

        <TabsContent value="features" className="mt-3">
          <Section
            title="功能权限"
            description={`签发时写入快照：产品默认值 → 套餐权限 → 授权覆盖值；已禁用的产品功能不能被授权强行开启。当前权限版本 v${license.entitlementsVersion}，客户端心跳看到版本变化会重新拉取权限。`}
            contentClassName="p-0"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEditFeatures}
                onClick={() => setFeatureDialogOpen(true)}
              >
                <ListChecks className="size-3.5" />
                调整功能权限
              </Button>
            }
          >
            <DataTable
              columns={featureColumns}
              rows={featureRows}
              rowKey={(row) => row.code}
              dense
              empty={<EmptyState title="该产品没有定义功能权限" description="可以到产品详情页添加功能编码。" icon={<ListChecks className="size-5" />} />}
            />
          </Section>
        </TabsContent>

        <TabsContent value="renewals" className="mt-3">
          <Section title="续费记录" description="每次续费保存旧到期时间、新到期时间与起算方式" contentClassName="p-0">
            <DataTable
              columns={renewalColumns}
              rows={data?.renewals ?? []}
              rowKey={(row) => row.id}
              dense
              empty={<EmptyState title="还没有续费记录" description="对未到期授权续费会从原到期时间顺延。" icon={<RefreshCcw className="size-5" />} />}
            />
          </Section>
        </TabsContent>

        <TabsContent value="events" className="mt-3">
          <Section title="验证与激活事件" description="来自 activation_events，记录激活、心跳异常、设备操作" contentClassName="p-0">
            <DataTable
              columns={eventColumns}
              rows={data?.events ?? []}
              rowKey={(row) => row.id}
              dense
              empty={<EmptyState title="暂无事件" description="设备首次激活后会写入事件。" />}
            />
          </Section>
        </TabsContent>

        <TabsContent value="audit" className="mt-3">
          <Section title="操作历史" description="管理员对这份授权执行的所有动作" contentClassName="p-0">
            <DataTable
              columns={auditColumns}
              rows={data?.auditLogs ?? []}
              rowKey={(row) => row.id}
              dense
              empty={<EmptyState title="暂无审计记录" description="签发、续费、暂停等操作都会记录。" icon={<History className="size-5" />} />}
            />
          </Section>
        </TabsContent>
      </Tabs>

      {license ? (
        <LicenseFeatureDialog
          open={featureDialogOpen}
          onOpenChange={setFeatureDialogOpen}
          licenseId={license.id}
          productId={license.product.id}
          productName={license.product.name}
          snapshot={license.featureSnapshot ?? {}}
          overrides={license.features ?? []}
          entitlementsVersion={license.entitlementsVersion}
          onSaved={refresh}
        />
      ) : null}

      <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        <Ban className="size-3" aria-hidden />
        撤销与作废是终态，不能直接恢复；如需恢复服务请签发替代授权。
        <span className="ml-auto">当前操作者：{session?.user.displayName}</span>
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      </div>
      <p className={mono ? "mt-1.5 truncate font-mono text-sm font-medium text-foreground" : "tabular mt-1.5 text-lg font-semibold text-foreground"}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
