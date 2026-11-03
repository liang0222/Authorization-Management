import type { PageResult } from "@/lib/types";

/**
 * 设备页共用类型与展示规则。
 *
 * 数据源是 activations（绑定行为），不是 devices（设备档案）：
 * 同一台设备解绑后重新激活会产生新的激活记录，历史必须保留。
 */

export interface DeviceActivationRow {
  id: string;
  status: string;
  device: {
    id: string;
    name: string | null;
    instanceId: string;
    platform: string;
    fingerprint: string | null;
    firstSeenAt: string;
  };
  license: { id: string; adminStatus: string; customerId: string; customerName: string };
  product: { id: string; name: string; code: string };
  activatedAt: string;
  lastSeenAt: string;
  releasedAt: string | null;
  clientVersion: string | null;
  lastIp: string | null;
  online: boolean;
}

export interface DevicesResponse extends PageResult<DeviceActivationRow> {
  summary: { byStatus: Record<string, number>; online: number };
}

export interface DeviceDetail {
  id: string;
  name: string | null;
  instanceId: string;
  platform: string;
  status: string;
  publicKeyThumbprint: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  product: { id: string; name: string; code: string };
  metadata: unknown;
}

export interface DeviceActivationHistory {
  id: string;
  status: string;
  licenseId: string;
  licenseAdminStatus: string;
  customerName: string;
  activatedAt: string;
  lastSeenAt: string;
  releasedAt: string | null;
  clientVersion: string | null;
  lastIp: string | null;
}

export interface DeviceEvent {
  id: string;
  activationId: string;
  type: string;
  actorType: string;
  createdAt: string;
  details: unknown;
}

export interface DeviceDetailResponse {
  device: DeviceDetail;
  activations: DeviceActivationHistory[];
  events: DeviceEvent[];
}

/** 激活记录状态：与服务端 activations.status 取值一一对应。 */
export const ACTIVATION_STATUSES = ["active", "released", "revoked", "blocked"] as const;

export const ACTIVATION_STATUS_LABEL: Record<string, string> = {
  active: "绑定中",
  released: "已解绑",
  revoked: "已撤销",
  blocked: "已禁用",
};

/** 设备档案状态（devices.status）。 */
export const DEVICE_STATUS_LABEL: Record<string, string> = {
  active: "正常",
  disabled: "已禁用",
  blocked: "已禁用",
  merged: "已合并",
};

/**
 * 平台筛选枚举：取产品 supported_platforms 里实际使用的取值，
 * 后端按 devices.platform 精确匹配，选到空集合时如实返回空态。
 */
export const PLATFORM_OPTIONS = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
  "chrome",
  "edge",
  "wechat",
] as const;

const PLATFORM_LABEL: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
  chrome: "Chrome 扩展",
  edge: "Edge 扩展",
  wechat: "微信小程序",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

/** IPv4 保留前两段；IPv6 保留前两组。仅用于无敏感字段权限时展示。 */
export function maskIp(ip: string | null): string {
  if (!ip) return "—";
  if (ip.includes(":")) {
    const head = ip.split(":").filter(Boolean).slice(0, 2).join(":");
    return `${head}:••••`;
  }
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.•••.•••`;
  return "•••";
}

/** 设备指纹（公钥缩略）只保留前 8 位，避免整段指纹进入截图与工单。 */
export function maskFingerprint(value: string | null): string {
  if (!value) return "—";
  if (value.length <= 12) return `${value.slice(0, 4)}••••`;
  return `${value.slice(0, 8)}••••${value.slice(-4)}`;
}
