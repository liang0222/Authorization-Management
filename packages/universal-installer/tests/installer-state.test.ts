import { describe, expect, it } from "vitest";
import {
  canRunInstall,
  canTransition,
  describeState,
  IllegalTransitionError,
  assertTransition,
  isInstallLocked,
  TRANSITIONS,
} from "../lib/installer/state";
import type { InstallState } from "../lib/installer/contract";

const ALL: InstallState[] = [
  "UNINSTALLED",
  "INSTALLING",
  "INSTALLED",
  "MAINTENANCE",
  "FAILED",
  "RECOVERY",
  "UNKNOWN",
];

describe("安装状态转移表", () => {
  it("UNINSTALLED 只能进 INSTALLING", () => {
    expect(TRANSITIONS.UNINSTALLED).toEqual(["INSTALLING"]);
  });

  it("INSTALLED 不能回到 UNINSTALLED / INSTALLING（防重装）", () => {
    expect(canTransition("INSTALLED", "UNINSTALLED")).toBe(false);
    expect(canTransition("INSTALLED", "INSTALLING")).toBe(false);
  });

  it("FAILED 只能进 RECOVERY", () => {
    expect(TRANSITIONS.FAILED).toEqual(["RECOVERY"]);
  });

  it("UNKNOWN 不能直接进 INSTALLING（库连不上时不许装）", () => {
    expect(canTransition("UNKNOWN", "INSTALLING")).toBe(false);
    expect(canTransition("UNKNOWN", "INSTALLED")).toBe(true);
  });

  it("自转移恒为真（幂等写入不该被判成非法）", () => {
    for (const state of ALL) {
      expect(canTransition(state, state), state).toBe(true);
    }
  });

  it("转移表覆盖全部 7 个状态", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it("每个目标是合法状态名", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL, `${from} → ${target}`).toContain(target);
      }
    }
  });

  it("非法转移抛 IllegalTransitionError", () => {
    expect(() => assertTransition("INSTALLED", "UNINSTALLED")).toThrow(IllegalTransitionError);
  });

  it("合法转移不抛", () => {
    expect(() => assertTransition("UNINSTALLED", "INSTALLING")).not.toThrow();
  });

  it("只有 4 个状态允许发起安装", () => {
    const allowed = ALL.filter(canRunInstall);
    expect(allowed.sort()).toEqual(["FAILED", "INSTALLING", "RECOVERY", "UNINSTALLED"]);
  });

  it("INSTALLED / MAINTENANCE / UNKNOWN 一律锁死", () => {
    expect(ALL.filter(isInstallLocked).sort()).toEqual(["INSTALLED", "MAINTENANCE", "UNKNOWN"]);
  });

  it("canRunInstall 与 isInstallLocked 对每个状态互补", () => {
    for (const state of ALL) {
      expect(canRunInstall(state) !== isInstallLocked(state), state).toBe(true);
    }
  });

  it("每种状态都有中文描述", () => {
    for (const state of ALL) {
      const text = describeState(state);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe(state);
    }
  });
});
