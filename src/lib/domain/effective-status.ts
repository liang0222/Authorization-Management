/**
 * 授权有效状态计算（规格 3.2）。
 *
 * 关键点：`effective_status` 是服务端计算结果，绝不写入 admin_status。
 * 设备上限 / 累计激活次数只影响“新激活”，不会让已绑定设备突然失效。
 */

export type LicenseAdminStatus =
  | "draft"
  | "pending"
  | "active"
  | "suspended"
  | "revoked"
  | "cancelled";

export type EffectiveStatus =
  | "product_disabled"
  | "revoked"
  | "cancelled"
  | "suspended"
  | "draft"
  | "activation_window_expired"
  | "not_yet_valid"
  | "expired"
  | "active";

export interface LicenseStateInput {
  adminStatus: LicenseAdminStatus;
  productStatus: "active" | "disabled" | "archived";
  startsAt: Date | null;
  expiresAt: Date | null;
  activationDeadlineAt: Date | null;
  /** 已经发生过首次激活（activation_count > 0）或存在激活记录 */
  hasActivated: boolean;
  /** 当前活跃设备数 */
  activeDeviceCount?: number;
  maxDevices?: number;
  activationCount?: number;
  maxActivationCount?: number | null;
}

export interface EffectiveState {
  status: EffectiveStatus;
  /** 是否还能通过在线校验使用授权（已绑定设备视角） */
  usable: boolean;
  /** 是否还允许新设备激活 */
  canActivate: boolean;
  /** 阻止新激活的具体原因，用于 API 错误码 */
  activationBlockReason:
    | null
    | "LICENSE_SUSPENDED"
    | "LICENSE_EXPIRED"
    | "ACTIVATION_WINDOW_EXPIRED"
    | "DEVICE_LIMIT_EXCEEDED"
    | "ACTIVATION_LIMIT_REACHED"
    | "LICENSE_INVALID";
  /** 人类可读的解释，仅用于管理后台展示 */
  reason: string;
}

function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

export function computeEffectiveState(input: LicenseStateInput, now: Date): EffectiveState {
  const base = {
    activeDeviceCount: input.activeDeviceCount ?? 0,
    maxDevices: input.maxDevices ?? 1,
    activationCount: input.activationCount ?? 0,
    maxActivationCount: input.maxActivationCount ?? null,
  };

  const blocked = (status: EffectiveStatus, reason: string): EffectiveState => ({
    status,
    usable: false,
    canActivate: false,
    activationBlockReason:
      status === "suspended"
        ? "LICENSE_SUSPENDED"
        : status === "expired"
          ? "LICENSE_EXPIRED"
          : status === "activation_window_expired"
            ? "ACTIVATION_WINDOW_EXPIRED"
            : "LICENSE_INVALID",
    reason,
    ...base,
  });

  if (input.productStatus !== "active") {
    return blocked("product_disabled", "产品已禁用，授权不可用");
  }
  if (input.adminStatus === "revoked") {
    return blocked("revoked", "授权已被撤销，不可恢复");
  }
  if (input.adminStatus === "cancelled") {
    return blocked("cancelled", "授权已作废");
  }
  if (input.adminStatus === "suspended") {
    return blocked("suspended", "授权已被管理员暂停");
  }
  if (input.adminStatus === "draft") {
    return blocked("draft", "授权仍是草稿，未签发兑换码");
  }
  if (
    !input.hasActivated &&
    input.activationDeadlineAt &&
    isBefore(input.activationDeadlineAt, now)
  ) {
    return blocked("activation_window_expired", "已超过首次激活截止时间");
  }
  if (input.startsAt && isBefore(now, input.startsAt)) {
    return blocked("not_yet_valid", "尚未到授权开始时间");
  }
  if (input.expiresAt && !isBefore(now, input.expiresAt)) {
    return blocked("expired", "授权已到期");
  }

  // 状态本身有效：再判断是否还能新增激活（不影响已绑定设备）
  let canActivate = true;
  let activationBlockReason: EffectiveState["activationBlockReason"] = null;
  let reason = "授权有效";
  if (base.activeDeviceCount >= base.maxDevices) {
    canActivate = false;
    activationBlockReason = "DEVICE_LIMIT_EXCEEDED";
    reason = "设备名额已满，仅影响新激活";
  }
  if (
    base.maxActivationCount !== null &&
    base.activationCount >= base.maxActivationCount
  ) {
    canActivate = false;
    activationBlockReason = "ACTIVATION_LIMIT_REACHED";
    reason = "累计激活次数已用尽，仅影响新激活";
  }

  return { status: "active", usable: true, canActivate, activationBlockReason, reason, ...base };
}

/** 有效状态的展示文案（Badge 同时显示文字与颜色，不靠颜色单独表意）。 */
export const EFFECTIVE_STATUS_LABEL: Record<EffectiveStatus, string> = {
  active: "有效",
  expired: "已到期",
  suspended: "已暂停",
  revoked: "已撤销",
  cancelled: "已作废",
  draft: "草稿",
  not_yet_valid: "未开始",
  activation_window_expired: "激活超时",
  product_disabled: "产品禁用",
};

export const ADMIN_STATUS_LABEL: Record<LicenseAdminStatus, string> = {
  draft: "草稿",
  pending: "待激活",
  active: "已激活",
  suspended: "已暂停",
  revoked: "已撤销",
  cancelled: "已作废",
};

/** 管理状态可执行的动作（前端按钮可用性与后端 RBAC 双重使用）。 */
export function availableAdminActions(status: LicenseAdminStatus): string[] {
  switch (status) {
    case "draft":
      return ["publish", "cancel"];
    case "pending":
      return ["suspend", "revoke", "cancel", "renew", "rekey"];
    case "active":
      return ["suspend", "revoke", "renew", "rekey", "reset-activation-count"];
    case "suspended":
      return ["resume", "revoke", "cancel", "renew"];
    default:
      // revoked / cancelled 是终态
      return [];
  }
}
