/**
 * 运行时配置：唯一的环境变量入口。
 *
 * 设计说明：
 * - 本开发环境禁止读写 `.env`（安全策略拦截），因此所有配置都提供“开发默认值”。
 * - 生产部署通过容器环境变量覆盖同名变量即可，无需修改代码。
 * - 任何密钥类默认值都明确标注 dev-only，并由 `assertProductionSafety()` 在生产校验。
 */

import { credentialEnvironmentFor } from "@/lib/domain/deployment-environment";

const DEV_DEFAULTS = {
  // 数据库变量名使用 LICENSE_DB_URL：本机环境禁止读写 .env，
  // 避免继承到无关的 DATABASE_URL（可能指向不存在的本地实例）。
  LICENSE_DB_URL:
    "postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public",
  SESSION_SECRET: "dev-only-session-secret-please-change-in-production-32bytes",
  LICENSE_HMAC_PEPPER: "dev-only-license-hmac-pepper-please-change-in-production",
  APP_BASE_URL: "http://127.0.0.1:3000",
  SIGNING_KEY_DIR: ".keys",
  /** 服务端断言的 aud：调用方必须把它写进 JWT，防止断言被别的服务复用。 */
  ASSERTION_AUDIENCE: "license-api",
  /**
   * 部署环境：production / sandbox / development。
   *
   * 规格 27.3 要求 Sandbox 与生产「独立数据库、独立签名密钥、独立限流命名空间、独立凭证」。
   * 同一份代码靠这个变量区分两套部署，因此它必须显式设置 —— 不设就落到 development，
   * 绝不默认成 production（默认生产会让测试流量打到真实客户账上）。
   */
  DEPLOYMENT_ENV: "development",
  /** 备份包加密密钥。生产必须显式设置；开发默认复用 sessionSecret 派生。 */
  BACKUP_ENCRYPTION_KEY: "dev-only-backup-encryption-key-please-change",
} as const;

function readEnv(key: keyof typeof DEV_DEFAULTS): string {
  const value = process.env[key];
  return value && value.length > 0 ? value : DEV_DEFAULTS[key];
}

/** 与 readEnv 不同：空串必须真的表示“没有”，不能回退到开发默认值。 */
function readOptionalEnv(key: string): string | null {
  const value = process.env[key];
  return value && value.length > 0 ? value : null;
}

export const config = {
  databaseUrl: readEnv("LICENSE_DB_URL"),
  sessionSecret: readEnv("SESSION_SECRET"),
  /**
   * 独立封存密钥（AES-256-GCM），保护 MFA 密钥、Webhook 签名密钥、备份存储凭证。
   * 未设置时回退到 sessionSecret 派生，与历史数据兼容。
   *
   * 为什么独立：sessionSecret 同时用于会话 Cookie 与 CSRF 校验，前者一换全员掉线，
   * 后者不换则有历史泄露风险；两者生命周期不同，不应共用一个根。
   */
  secretboxKey: readOptionalEnv("SECRETBOX_KEY") ?? readEnv("SESSION_SECRET"),
  /** 轮换期间的旧封存密钥（逗号分隔）：只用于解密，绝不用于新加密。 */
  secretboxLegacyKeys: (process.env.SECRETBOX_KEYS_LEGACY ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
  licenseHmacPepper: readEnv("LICENSE_HMAC_PEPPER"),
  /**
   * 授权码 HMAC pepper 版本环（规格 2.3-E）。
   *
   * 授权码明文不落库，只存 HMAC，因此换 pepper 之后旧码无法重算。
   * 做法是“当前 pepper + 只读旧 pepper”：校验时逐个尝试，命中旧 pepper 时
   * 就地把该行重哈希到当前 pepper（这一刻明文正好在手）。轮换不需要客户
   * 重新兑换，也不会让存量授权失效。
   */
  licenseHmacPepperVersion: readOptionalEnv("LICENSE_HMAC_PEPPER_VERSION") ?? "v1",
  licenseHmacPepperLegacy: readOptionalEnv("LICENSE_HMAC_PEPPER_LEGACY"),
  licenseHmacPepperLegacyVersion: readOptionalEnv("LICENSE_HMAC_PEPPER_LEGACY_VERSION") ?? "v1",
  appBaseUrl: readEnv("APP_BASE_URL"),
  signingKeyDir: readEnv("SIGNING_KEY_DIR"),
  assertionAudience: readEnv("ASSERTION_AUDIENCE"),
  /** production | sandbox | development —— 见 DEPLOYMENT_ENV 的说明。 */
  deploymentEnv: readEnv("DEPLOYMENT_ENV"),
  isSandbox: readEnv("DEPLOYMENT_ENV") === "sandbox",
  backupEncryptionKey: readEnv("BACKUP_ENCRYPTION_KEY"),
  /** 备份落盘根目录（Local 暂存区，同时也是「必需目标」之一）。 */
  backupLocalDir: process.env.BACKUP_LOCAL_DIR ?? ".backups",
  /**
   * 开发环境的“邮件出口”：密码重置链接直接返回给前端展示。
   * 生产必须设置 DEV_MAIL_SINK=false，否则重置链接会泄露给调用方。
   */
  devMailSink: (process.env.DEV_MAIL_SINK ?? "true") !== "false",
  isProduction: process.env.NODE_ENV === "production",
  /**
   * 本进程可以使用的产品凭证环境（规格 27.3「独立产品凭证」）。
   *
   * - `sandbox` 进程只能看到 `environment = 'sandbox'` 的凭证；
   * - production 与 development 共用 `production` 池：development 是「本地跑生产代码」，
   *   它必须能验通现网那套 client_id，否则联调无意义。
   *
   * 这条边界由 `product_credentials.environment` 与这里共同保证：
   * 沙箱签出来的 client_id 拿到生产环境调用会直接 401，反之亦然。
   */
  credentialEnvironment: credentialEnvironmentFor(readEnv("DEPLOYMENT_ENV")),
} as const;

const VALID_ENVS = new Set(["production", "sandbox", "development"]);

/** 生产环境禁止使用开发默认密钥。返回问题列表，空数组表示通过。 */
export function productionSafetyIssues(): string[] {
  const issues: string[] = [];

  if (!VALID_ENVS.has(config.deploymentEnv)) {
    issues.push(`DEPLOYMENT_ENV 只能是 production / sandbox / development，当前是 ${config.deploymentEnv}`);
  }
  // 签名密钥按环境分目录：Sandbox 的私钥绝不能签生产授权。
  if (config.deploymentEnv === "production" && config.signingKeyDir === DEV_DEFAULTS.SIGNING_KEY_DIR) {
    issues.push("生产的 SIGNING_KEY_DIR 不能与开发共用 .keys");
  }
  if (config.deploymentEnv === "production" && config.isSandbox) {
    issues.push("DEPLOYMENT_ENV 自相矛盾");
  }

  if (!config.isProduction) return issues;

  if (config.sessionSecret === DEV_DEFAULTS.SESSION_SECRET) {
    issues.push("SESSION_SECRET 仍是开发默认值");
  }
  if (config.licenseHmacPepper === DEV_DEFAULTS.LICENSE_HMAC_PEPPER) {
    issues.push("LICENSE_HMAC_PEPPER 仍是开发默认值");
  }
  if (config.devMailSink) {
    issues.push("DEV_MAIL_SINK 必须为 false");
  }
  if (config.backupEncryptionKey === DEV_DEFAULTS.BACKUP_ENCRYPTION_KEY) {
    issues.push("BACKUP_ENCRYPTION_KEY 仍是开发默认值");
  }
  return issues;
}
