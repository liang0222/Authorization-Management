/**
 * 安装状态机（规格 §八）。
 *
 * 为什么要有显式转移表：规格要求「每个状态都必须有明确的转换条件」，而且
 * 「安装完成后，即使清理浏览器缓存、修改 URL、服务器重启或容器重建，
 *   也不能重新进入首次安装」。把转移写成表，任何非法转移都会抛错而不是
 * 悄悄落库，测试也能直接穷举。
 */
import type { InstallState } from "./contract";

/** 完整转移表。导出是为了让测试能穷举，也让运维能一眼看到全部规则。 */
export const TRANSITIONS: Record<InstallState, readonly InstallState[]> = {
  // 从未装过 → 开始装 / 被别人抢先标成安装中
  UNINSTALLED: ["INSTALLING"],
  // 安装中 → 成功 / 失败 / 中断后进恢复
  INSTALLING: ["INSTALLED", "FAILED", "RECOVERY"],
  // 已装 → 维护模式 / 被判定为篡改后重新校验（仍回 INSTALLED）
  INSTALLED: ["MAINTENANCE", "INSTALLED"],
  // 维护 → 回到已装
  MAINTENANCE: ["INSTALLED"],
  // 失败 → 恢复（不允许直接从 FAILED 再进 INSTALLING，必须经过 RECOVERY）
  FAILED: ["RECOVERY"],
  // 恢复 → 继续安装 / 回到已装（若恢复时发现其实已经装好）/ 再次失败
  RECOVERY: ["INSTALLING", "INSTALLED", "FAILED"],
  // 无法判定：只允许在证据补齐后收敛，绝不允许直接进 INSTALLING
  UNKNOWN: ["UNINSTALLED", "INSTALLED", "UNKNOWN"],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: InstallState,
    readonly to: InstallState,
  ) {
    super(`非法状态转移：${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: InstallState, to: InstallState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: InstallState, to: InstallState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/** 只有这两个状态允许执行安装流水线。 */
export function canRunInstall(state: InstallState): boolean {
  return state === "UNINSTALLED" || state === "FAILED" || state === "RECOVERY" || state === "INSTALLING";
}

/**
 * 安装入口是否必须关闭。UNKNOWN 也关——连不上库时不能让人重装，
 * 否则会把一个只是暂时不可用的已装实例覆盖掉。
 */
export function isInstallLocked(state: InstallState): boolean {
  return state === "INSTALLED" || state === "MAINTENANCE" || state === "UNKNOWN";
}

/** 给人看的状态说明。 */
export function describeState(state: InstallState): string {
  switch (state) {
    case "UNINSTALLED":
      return "尚未安装";
    case "INSTALLING":
      return "正在安装";
    case "INSTALLED":
      return "已安装";
    case "MAINTENANCE":
      return "维护模式";
    case "FAILED":
      return "安装失败，可恢复";
    case "RECOVERY":
      return "恢复中";
    case "UNKNOWN":
      return "状态未知";
  }
}
