/**
 * seed 生产护栏（阶段 2）。
 *
 * 背景：`prisma/seed.ts` 会先对 30 张表 `TRUNCATE ... RESTART IDENTITY CASCADE` 再灌演示数据，
 * 打的是 `LICENSE_DB_URL` 指向的库。阶段 0 就这么误伤过一次现网库（3100 变 503）。
 * 所以在**连库之前**就要拦住：生产身份默认拒绝，只有显式 `ALLOW_DEMO_SEED=true` 才放行。
 *
 * 判定放在纯函数里，是为了让单测能覆盖四种组合而不真的跑 seed。
 */

/** 显式豁免开关的变量名。 */
export const ALLOW_DEMO_SEED = "ALLOW_DEMO_SEED";

export type SeedGuardEnv = {
  NODE_ENV?: string | undefined;
  DEPLOYMENT_ENV?: string | undefined;
  ALLOW_DEMO_SEED?: string | undefined;
};

export type SeedGuardDecision = {
  /** 是否允许继续执行 seed。 */
  allowed: boolean;
  /** 生产身份：`NODE_ENV` 或 `DEPLOYMENT_ENV` 任一为 `production`。 */
  productionLike: boolean;
  /** 是否走了显式豁免。 */
  overridden: boolean;
  /** 拒绝原因（`allowed=false` 时必有）。 */
  reason?: string;
  /** 放行时的醒目警告（仅「生产 + 显式豁免」才有）。 */
  warning?: string;
};

/**
 * 生产身份判定：两个变量取「或」而不是「与」。
 *
 * 因为误跑的两种姿势都真实存在：容器里 `DEPLOYMENT_ENV=production` 但 `NODE_ENV` 没设；
 * 或者拿生产构建（`NODE_ENV=production`）在本地连了生产库。任一命中就不该自动灌种子。
 */
export function isProductionSeedContext(env: SeedGuardEnv): boolean {
  return env.NODE_ENV === "production" || env.DEPLOYMENT_ENV === "production";
}

export function seedGuardDecision(env: SeedGuardEnv): SeedGuardDecision {
  const productionLike = isProductionSeedContext(env);
  // 只认精确的 "true"：写成 1 / yes / TRUE 一律视为没有豁免，宁可让人重跑一次，
  // 也不要因为一个拼写松弛的开关把生产库清空。
  const overridden = env[ALLOW_DEMO_SEED] === "true";

  if (!productionLike) {
    return { allowed: true, productionLike: false, overridden: false };
  }

  if (!overridden) {
    return {
      allowed: false,
      productionLike: true,
      overridden: false,
      reason: [
        "拒绝执行 seed：当前是生产身份（NODE_ENV 或 DEPLOYMENT_ENV 为 production）。",
        "prisma/seed.ts 会先 TRUNCATE 30 张业务表再灌演示数据，这会把生产数据清空。",
        `如果确实是要给一台**全新的**生产/演示实例灌种子，显式设置 ${ALLOW_DEMO_SEED}=true 再跑一次。`,
        "开发与沙箱环境不受影响，无需设置该变量。",
      ].join("\n"),
    };
  }

  return {
    allowed: true,
    productionLike: true,
    overridden: true,
    warning: [
      "================================================================",
      `⚠️  ${ALLOW_DEMO_SEED}=true：正在以生产身份执行演示种子数据！`,
      "⚠️  这会清空 30 张业务表（TRUNCATE ... RESTART IDENTITY CASCADE）。",
      "⚠️  灌进去的账号密码是公开的演示口令，灌完必须立刻改密或删除。",
      "================================================================",
    ].join("\n"),
  };
}
