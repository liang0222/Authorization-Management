"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ADMIN_STATUS_LABEL,
  EFFECTIVE_STATUS_LABEL,
  type EffectiveStatus,
  type LicenseAdminStatus,
} from "@/lib/domain/effective-status";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

const TONE_CLASS: Record<Tone, string> = {
  success: "status-success",
  warning: "status-warning",
  danger: "status-danger",
  info: "status-info",
  neutral: "status-neutral",
  brand: "status-brand",
};

export function ToneBadge({
  tone,
  children,
  className,
  dot = true,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", TONE_CLASS[tone], className)}>
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </Badge>
  );
}

const EFFECTIVE_TONE: Record<EffectiveStatus, Tone> = {
  active: "success",
  expired: "danger",
  suspended: "warning",
  revoked: "danger",
  cancelled: "neutral",
  draft: "neutral",
  not_yet_valid: "info",
  activation_window_expired: "warning",
  product_disabled: "danger",
};

/** 有效状态徽章：由服务端计算，前端只负责展示。 */
export function EffectiveStatusBadge({ status }: { status: EffectiveStatus }) {
  return <ToneBadge tone={EFFECTIVE_TONE[status]}>{EFFECTIVE_STATUS_LABEL[status]}</ToneBadge>;
}

const ADMIN_TONE: Record<LicenseAdminStatus, Tone> = {
  draft: "neutral",
  pending: "info",
  active: "brand",
  suspended: "warning",
  revoked: "danger",
  cancelled: "neutral",
};

/** 管理状态徽章：与有效状态分开显示，避免把暂停/撤销/到期混成一个标签。 */
export function AdminStatusBadge({ status }: { status: LicenseAdminStatus }) {
  return (
    <ToneBadge tone={ADMIN_TONE[status]} dot={false}>
      {ADMIN_STATUS_LABEL[status]}
    </ToneBadge>
  );
}

const RECORD_STATUS_LABEL: Record<string, string> = {
  active: "启用",
  disabled: "已禁用",
  archived: "已归档",
};

export function RecordStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "active" ? "success" : status === "disabled" ? "warning" : "neutral";
  return <ToneBadge tone={tone}>{RECORD_STATUS_LABEL[status] ?? status}</ToneBadge>;
}

const ACTIVATION_LABEL: Record<string, string> = {
  active: "绑定中",
  released: "已解绑",
  revoked: "已撤销",
  blocked: "已禁用",
};

export function ActivationStatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === "active" ? "success" : status === "blocked" ? "warning" : status === "revoked" ? "danger" : "neutral";
  return <ToneBadge tone={tone}>{ACTIVATION_LABEL[status] ?? status}</ToneBadge>;
}

const HTTP_STATUS_TONE = (status: number): Tone => {
  if (status < 300) return "success";
  if (status < 400) return "info";
  if (status < 500) return "warning";
  return "danger";
};

/** HTTP 状态码（验证日志用）：2xx 成功、4xx 客户端错误、5xx 服务端错误。 */
export function HttpStatusBadge({ status }: { status: number }) {
  return <ToneBadge tone={HTTP_STATUS_TONE(status)} dot={false}>{status}</ToneBadge>;
}

const DELIVERY_LABEL: Record<string, string> = {
  succeeded: "投递成功",
  failed: "投递失败",
  pending: "等待投递",
  delivering: "投递中",
  dead: "已终止",
};

export function DeliveryStatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === "succeeded" ? "success" : status === "failed" ? "warning" : status === "dead" ? "danger" : "info";
  return <ToneBadge tone={tone}>{DELIVERY_LABEL[status] ?? status}</ToneBadge>;
}
