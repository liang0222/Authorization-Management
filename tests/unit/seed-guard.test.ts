import { describe, expect, it } from "vitest";
import { ALLOW_DEMO_SEED, isProductionSeedContext, seedGuardDecision } from "@/lib/seed-guard";

/**
 * seed 生产护栏（阶段 2）。
 *
 * 为什么值得单测：`prisma/seed.ts` 的第一件事是 TRUNCATE 30 张表。
 * 这个判定写错的代价不是「多灌一次数据」，而是「把库清空」。
 * 阶段 0 就真实误伤过一次现网库（3100 变 503），所以四种组合都要钉住。
 */
describe("seed 生产护栏", () => {
  it("开发环境：直接放行，不提示", () => {
    const decision = seedGuardDecision({ NODE_ENV: "development", DEPLOYMENT_ENV: "development" });
    expect(decision.allowed).toBe(true);
    expect(decision.productionLike).toBe(false);
    expect(decision.overridden).toBe(false);
    expect(decision.warning).toBeUndefined();
  });

  it("完全没有设置任何变量：当作开发，放行", () => {
    const decision = seedGuardDecision({});
    expect(decision.allowed).toBe(true);
    expect(decision.productionLike).toBe(false);
  });

  it("沙箱环境：放行（沙箱本来就该灌种子）", () => {
    const decision = seedGuardDecision({ NODE_ENV: "production", DEPLOYMENT_ENV: "sandbox" });
    // 说明：沙箱跑的是生产构建（npm start 必然是 NODE_ENV=production），
    // 所以 NODE_ENV 这一侧会命中生产身份——沙箱必须显式带 ALLOW_DEMO_SEED=true 才能 seed。
    expect(decision.productionLike).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it("NODE_ENV=production：拒绝，且给出原因", () => {
    const decision = seedGuardDecision({ NODE_ENV: "production", DEPLOYMENT_ENV: "development" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("拒绝执行 seed");
    expect(decision.reason).toContain("TRUNCATE");
    expect(decision.reason).toContain(ALLOW_DEMO_SEED);
  });

  it("DEPLOYMENT_ENV=production（NODE_ENV 未设）：同样拒绝", () => {
    const decision = seedGuardDecision({ DEPLOYMENT_ENV: "production" });
    expect(decision.allowed).toBe(false);
    expect(decision.productionLike).toBe(true);
  });

  it("生产 + ALLOW_DEMO_SEED=true：放行，但必须有醒目警告", () => {
    const decision = seedGuardDecision({
      NODE_ENV: "production",
      DEPLOYMENT_ENV: "production",
      [ALLOW_DEMO_SEED]: "true",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.overridden).toBe(true);
    expect(decision.warning).toContain("正在以生产身份执行演示种子数据");
    expect(decision.warning).toContain("⚠️");
  });

  it("只认精确的 true：1 / TRUE / yes 都不算豁免", () => {
    for (const value of ["1", "TRUE", "yes", "on", "True"]) {
      const decision = seedGuardDecision({ NODE_ENV: "production", [ALLOW_DEMO_SEED]: value });
      expect(decision.allowed, `ALLOW_DEMO_SEED=${value} 不该放行`).toBe(false);
      expect(decision.overridden).toBe(false);
    }
  });

  it("isProductionSeedContext：两个变量取或", () => {
    expect(isProductionSeedContext({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionSeedContext({ DEPLOYMENT_ENV: "production" })).toBe(true);
    expect(isProductionSeedContext({ NODE_ENV: "development", DEPLOYMENT_ENV: "sandbox" })).toBe(false);
  });
});
