import { describe, expect, it } from "vitest";
import { computeEffectiveState, availableAdminActions, type LicenseStateInput } from "@/lib/domain/effective-status";

const NOW = new Date("2026-11-02T00:00:00Z");
const base: LicenseStateInput = {
  adminStatus: "active",
  productStatus: "active",
  startsAt: new Date("2026-10-01T00:00:00Z"),
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  activationDeadlineAt: null,
  hasActivated: true,
  activeDeviceCount: 1,
  maxDevices: 2,
  activationCount: 1,
  maxActivationCount: 5,
};

describe("effective_status 优先级（规格 3.2）", () => {
  it("产品禁用优先于一切", () => {
    const state = computeEffectiveState({ ...base, productStatus: "disabled", adminStatus: "revoked" }, NOW);
    expect(state.status).toBe("product_disabled");
    expect(state.usable).toBe(false);
  });

  it("撤销优先于暂停", () => {
    expect(computeEffectiveState({ ...base, adminStatus: "revoked" }, NOW).status).toBe("revoked");
  });

  it("作废是终态", () => {
    const state = computeEffectiveState({ ...base, adminStatus: "cancelled" }, NOW);
    expect(state.status).toBe("cancelled");
  });

  it("暂停状态不可用但可恢复", () => {
    const state = computeEffectiveState({ ...base, adminStatus: "suspended" }, NOW);
    expect(state.status).toBe("suspended");
    expect(state.usable).toBe(false);
    expect(availableAdminActions("suspended")).toContain("resume");
  });

  it("草稿不可用", () => {
    expect(computeEffectiveState({ ...base, adminStatus: "draft", hasActivated: false }, NOW).status).toBe("draft");
  });

  it("未激活且超过激活截止 → activation_window_expired", () => {
    const state = computeEffectiveState(
      {
        ...base,
        adminStatus: "pending",
        startsAt: null,
        expiresAt: null,
        hasActivated: false,
        activationDeadlineAt: new Date("2026-10-20T00:00:00Z"),
      },
      NOW,
    );
    expect(state.status).toBe("activation_window_expired");
  });

  it("未到开始时间 → not_yet_valid", () => {
    const state = computeEffectiveState(
      { ...base, startsAt: new Date("2026-12-01T00:00:00Z"), expiresAt: new Date("2027-01-01T00:00:00Z") },
      NOW,
    );
    expect(state.status).toBe("not_yet_valid");
  });

  it("到达到期时间 → expired（边界相等即过期）", () => {
    const state = computeEffectiveState({ ...base, expiresAt: new Date("2026-11-02T00:00:00Z") }, NOW);
    expect(state.status).toBe("expired");
  });

  it("永久授权没有到期时间仍是 active", () => {
    const state = computeEffectiveState({ ...base, expiresAt: null }, NOW);
    expect(state.status).toBe("active");
    expect(state.usable).toBe(true);
  });
});

describe("设备上限 / 累计激活次数只影响新激活", () => {
  it("设备名额已满：仍然 usable，但不能新激活", () => {
    const state = computeEffectiveState({ ...base, activeDeviceCount: 2, maxDevices: 2 }, NOW);
    expect(state.status).toBe("active");
    expect(state.usable).toBe(true);
    expect(state.canActivate).toBe(false);
    expect(state.activationBlockReason).toBe("DEVICE_LIMIT_EXCEEDED");
  });

  it("累计激活次数用尽：同样不影响已绑定设备", () => {
    const state = computeEffectiveState({ ...base, activationCount: 5, maxActivationCount: 5 }, NOW);
    expect(state.status).toBe("active");
    expect(state.usable).toBe(true);
    expect(state.canActivate).toBe(false);
    expect(state.activationBlockReason).toBe("ACTIVATION_LIMIT_REACHED");
  });

  it("累计次数为 null 表示不限", () => {
    const state = computeEffectiveState({ ...base, activationCount: 999, maxActivationCount: null }, NOW);
    expect(state.canActivate).toBe(true);
  });
});

describe("管理动作白名单", () => {
  it("终态没有任何动作", () => {
    expect(availableAdminActions("revoked")).toEqual([]);
    expect(availableAdminActions("cancelled")).toEqual([]);
  });
  it("草稿只能发布或作废", () => {
    expect(availableAdminActions("draft").sort()).toEqual(["cancel", "publish"]);
  });
  it("已激活可暂停/撤销/续费/重发/重置次数", () => {
    const actions = availableAdminActions("active");
    expect(actions).toContain("suspend");
    expect(actions).toContain("revoke");
    expect(actions).toContain("renew");
    expect(actions).toContain("rekey");
    expect(actions).toContain("reset-activation-count");
  });
});
