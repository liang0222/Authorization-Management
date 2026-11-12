"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Fingerprint, History, Laptop, RefreshCw, ShieldCheck } from "lucide-react";
import { InfoGrid, PageHeader, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/app/feedback";
import { ActivationStatusBadge, ToneBadge, type Tone } from "@/components/app/status-badge";
import { ActivationActions } from "@/components/licensing/activation-actions";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { formatDateTime, formatRelative } from "@/lib/format";
import {
  DEVICE_STATUS_LABEL,
  maskFingerprint,
  maskIp,
  platformLabel,
  type DeviceActivationHistory,
  type DeviceDetailResponse,
  type DeviceEvent,
} from "@/components/devices/device-shared";

/**
 * 设备详情页（规格 15.8）。
 *
 * 数据来源是 `GET /api/v1/admin/devices/{id}`：
 * - device：设备档案（首次出现、最近心跳、平台、公钥指纹）
 * - activations：这台设备的历史绑定记录（含已解绑的，历史必须保留）
 * - events：最近 50 条激活事件时间线
 *
 * 设备页列表本来就跳这里，之前缺页面会 404 —— 这个文件补上入口。
 */

const DEVICE_STATUS_TONE: Record<string, Tone> = {
  active: "success",
  disabled: "warning",
  blocked: "danger",
  merged: "neutral",
};

const EVENT_LABEL: Record<string, string> = {
  created: "创建绑定",
  heartbeat: "心跳",
  released: "解绑",
  blocked: "禁用",
  unblocked: "恢复",
  revoked: "撤销",
  expired: "过期",
};

const ACTOR_LABEL: Record<string, string> = {
  system: "系统",
  admin: "后台管理员",
  client: "客户端",
};

function DeviceDetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { status: sessionStatus, hasPermission } = useSession();
  const { data, error, isLoading, isRefreshing, refresh } = useResource<DeviceDetailResponse>(
    id ? `/api/v1/admin/devices/${id}` : null,
  );

  const canRead = sessionStatus !== "ready" || hasPermission("activation:read");
  const canWrite = hasPermission("activation:revoke");

  const activationColumns = useMemo<DataColumn<DeviceActivationHistory>[]>(
    () => [
      {
        key: "status",
        header: "状态",
        cell: (row) => <ActivationStatusBadge status={row.status} />,
        width: "96px",
      },
      {
        key: "customer",
        header: "客户",
        cell: (row) => <span className="text-xs font-medium text-foreground">{row.customerName}</span>,
      },
      {
        key: "license",
        header: "所属授权",
        cell: (row) => (
          <Link
            href={`/app/licenses/${row.licenseId}`}
            onClick={(event) => event.stopPropagation()}
            className="font-mono text-[11px] text-muted-foreground underline-offset-4 hover:underline"
          >
            {row.licenseId.slice(0, 8)}
          </Link>
        ),
        width: "110px",
      },
      {
        key: "window",
        header: "激活 / 最近心跳",
        cell: (row) => (
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <p>激活 {formatDateTime(row.activatedAt)}</p>
            <p>心跳 {formatRelative(row.lastSeenAt)}</p>
            {row.releasedAt ? <p>解绑 {formatDateTime(row.releasedAt)}</p> : null}
          </div>
        ),
        width: "200px",
      },
      {
        key: "client",
        header: "客户端 / IP",
        cell: (row) => (
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <p>{row.clientVersion ?? "未知版本"}</p>
            <p className="font-mono">{maskIp(row.lastIp)}</p>
          </div>
        ),
        width: "150px",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) =>
          canWrite && row.status !== "released" ? (
            <div onClick={(event) => event.stopPropagation()}>
              <ActivationActions
                activation={{ id: row.id, status: row.status, deviceName: null }}
                onChanged={refresh}
                compact
              />
            </div>
          ) : null,
        width: "70px",
      },
    ],
    [canWrite, refresh],
  );

  const eventColumns = useMemo<DataColumn<DeviceEvent>[]>(
    () => [
      {
        key: "type",
        header: "事件",
        cell: (row) => <span className="text-xs font-medium">{EVENT_LABEL[row.type] ?? row.type}</span>,
        width: "120px",
      },
      {
        key: "actor",
        header: "触发方",
        cell: (row) => (
          <ToneBadge tone={row.actorType === "admin" ? "info" : "neutral"}>
            {ACTOR_LABEL[row.actorType] ?? row.actorType}
          </ToneBadge>
        ),
        width: "120px",
      },
      {
        key: "activation",
        header: "绑定记录",
        cell: (row) => (
          <span className="font-mono text-[11px] text-muted-foreground">{row.activationId.slice(0, 8)}</span>
        ),
        width: "100px",
      },
      {
        key: "at",
        header: "时间",
        cell: (row) => (
          <span className="text-[11px] text-muted-foreground">{formatDateTime(row.createdAt)}</span>
        ),
        width: "180px",
      },
    ],
    [],
  );

  if (sessionStatus === "ready" && !canRead) {
    return (
      <EmptyState
        title="没有查看设备的权限"
        description="当前角色缺少 activation:read 权限，请联系所有者分配。"
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

  const { device, activations, events } = data;
  const activeRow = activations.find((row) => row.status === "active") ?? null;

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[
          { label: "设备与激活" },
          { label: "设备列表", href: "/app/devices" },
          { label: device.name ?? device.instanceId.slice(0, 12) },
        ]}
        title={device.name ?? "未命名设备"}
        description={`${device.product.name} · ${platformLabel(device.platform)}`}
        meta={
          <>
            <ToneBadge tone={DEVICE_STATUS_TONE[device.status] ?? "neutral"} dot>
              {DEVICE_STATUS_LABEL[device.status] ?? device.status}
            </ToneBadge>
            {activeRow ? (
              <ToneBadge tone="success" dot>
                当前绑定中
              </ToneBadge>
            ) : (
              <ToneBadge tone="neutral">当前未绑定</ToneBadge>
            )}
            <span className="text-xs text-muted-foreground">
              共 {activations.length} 条绑定记录
            </span>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/devices">
                <ArrowLeft className="size-3.5" /> 返回列表
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} /> 刷新
            </Button>
          </>
        }
      />

      <Section title="设备档案" description="设备指纹由客户端首次激活时生成，用于识别同一台机器。">
        <InfoGrid
          columns={3}
          items={[
            { label: "设备名称", value: device.name ?? "未上报" },
            { label: "平台", value: platformLabel(device.platform) },
            { label: "设备状态", value: DEVICE_STATUS_LABEL[device.status] ?? device.status },
            { label: "产品", value: device.product.name },
            { label: "首次出现", value: formatDateTime(device.firstSeenAt) },
            {
              label: "最近心跳",
              value: device.lastSeenAt ? formatRelative(device.lastSeenAt) : "从未上报",
              hint: device.lastSeenAt ? formatDateTime(device.lastSeenAt) : "该设备尚未发送过心跳",
            },
            {
              label: "设备标识",
              value: <span className="break-all font-mono text-[11px]">{device.instanceId}</span>,
            },
            {
              label: "公钥指纹",
              value: <span className="font-mono text-[11px]">{maskFingerprint(device.publicKeyThumbprint)}</span>,
              hint: "只显示前后缀，避免整段指纹进入截图与工单",
            },
            { label: "设备 ID", value: <span className="font-mono text-[11px]">{device.id}</span> },
          ]}
        />
      </Section>

      <Section
        title="绑定记录"
        description="同一台设备解绑后重新激活会产生新记录，历史不做覆盖。"
      >
        <div className="-m-4">
          <DataTable
            columns={activationColumns}
            rows={activations}
            rowKey={(row) => row.id}
            caption="该设备的绑定记录"
            empty={
              <EmptyState
                title="还没有绑定记录"
                description="设备档案存在但没有激活记录，可能是客户端预注册后未完成激活。"
                icon={<Laptop className="size-5" />}
              />
            }
          />
        </div>
      </Section>

      <Section
        title="事件时间线"
        description="最近 50 条激活事件，用于排查「为什么突然掉线 / 为什么设备数对不上」。"
        actions={
          <Button variant="ghost" size="xs" asChild>
            <Link href={`/app/security/audit-logs?q=${device.instanceId}`}>
              在审计日志中搜索 <History className="size-3" />
            </Link>
          </Button>
        }
      >
        <div className="-m-4">
          <DataTable
            columns={eventColumns}
            rows={events}
            rowKey={(row) => row.id}
            caption="设备激活事件"
            empty={
              <EmptyState
                title="没有事件记录"
                description="激活事件在创建绑定、心跳、解绑、禁用时会写入。"
                icon={<Fingerprint className="size-5" />}
              />
            }
          />
        </div>
      </Section>

      <Section title="排障提示" description="常见「设备数超限」的复核顺序。">
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            先看绑定记录里是否还有 `绑定中` 的旧记录：解绑失败会一直占名额。
          </li>
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            对比授权详情页的设备上限与当前设备数，确认是「名额满」还是「校验失败」。
          </li>
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            事件时间线里出现 `blocked` 说明是管理员禁用，不是客户端掉线。
          </li>
        </ul>
      </Section>

      {activeRow ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => router.push(`/app/licenses/${activeRow.licenseId}`)}>
            查看当前授权详情
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function DeviceDetailPage() {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <DeviceDetailInner />
    </Suspense>
  );
}
