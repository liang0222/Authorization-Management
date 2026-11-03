/**
 * 部署环境与凭证池的映射（规格 27.3）。
 *
 * 抽成纯函数而不是写死在 `config` 里，是为了让「哪个环境用哪套凭证」这条规则
 * 能被单测直接钉住 —— 这条边界一旦写错，沙箱的 client_id 就能打通生产。
 */

/** 凭证池只有两个：生产池与沙箱池。 */
export type CredentialEnvironment = "production" | "sandbox";

/** 合法部署环境。 */
export const DEPLOYMENT_ENVS = ["production", "sandbox", "development"] as const;
export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number];

/**
 * 某个部署环境该用哪个凭证池。
 *
 * - `sandbox` → 沙箱池；
 * - `production` 与 `development` → 生产池。
 *
 * `development` 归到生产池是刻意的：本地开发跑的就是生产那份代码与数据，
 * 必须能验通现网那套 client_id，否则联调没有意义。真正需要「完全隔离」时，
 * 用 `DEPLOYMENT_ENV=sandbox` 起一个独立实例。
 */
export function credentialEnvironmentFor(deploymentEnv: string): CredentialEnvironment {
  return deploymentEnv === "sandbox" ? "sandbox" : "production";
}

/** 该部署环境是否与生产数据隔离。 */
export function isIsolatedEnvironment(deploymentEnv: string): boolean {
  return deploymentEnv === "sandbox";
}
