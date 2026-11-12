import { describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { bootMustFail, bootSafetyIssues } from "@/instrumentation";

/**
 * 启动闸门（阶段 1）。
 *
 * 背景：阶段 0 实测过 `NODE_ENV=production` + `DEPLOYMENT_ENV=development` +
 * 开发默认密钥 + `DEV_MAIL_SINK=true` 只打一行 `[boot] ... 配置检查未通过` 警告就照常启动。
 * 根因是 `register()` 用 `DEPLOYMENT_ENV === "production"` 判断要不要抛，
 * 而生产构建的身份其实由 `NODE_ENV` 决定。
 *
 * 现在：`bootMustFail()` 只看 `NODE_ENV=production`，与 `DEPLOYMENT_ENV` 无关。
 *
 * 测试手法：`config` 是 `as const` 的普通对象，运行时可改；
 * 这里逐项改快照再还原，避免为了测试去引入进程级重启。
 */

type MutableConfig = Record<string, unknown>;

/** 在给定的配置快照下执行断言，结束后无论如何还原。 */
function withConfig<T>(patch: Record<string, unknown>, run: () => T): T {
  const mutable = config as unknown as MutableConfig;
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) snapshot[key] = mutable[key];
  Object.assign(mutable, patch);
  try {
    return run();
  } finally {
    Object.assign(mutable, snapshot);
  }
}

/** 一份「生产正确配置」：非默认密钥、关闭邮件出口、独立密钥目录。 */
const PROD_OK = {
  isProduction: true,
  isSandbox: false,
  deploymentEnv: "production",
  sessionSecret: "prod-session-secret-not-a-dev-default-32bytes",
  licenseHmacPepper: "prod-license-hmac-pepper-not-a-dev-default",
  backupEncryptionKey: "prod-backup-encryption-key-not-a-dev-default",
  devMailSink: false,
  signingKeyDir: ".keys-prod",
  backupLocalDir: ".backups",
};

/** 一份「本地开发」配置：NODE_ENV 不是 production，用的全是开发默认值。 */
const DEV_OK = {
  isProduction: false,
  isSandbox: false,
  deploymentEnv: "development",
  sessionSecret: "dev-only-session-secret-please-change-in-production-32bytes",
  licenseHmacPepper: "dev-only-license-hmac-pepper-please-change-in-production",
  backupEncryptionKey: "dev-only-backup-encryption-key-please-change",
  devMailSink: true,
  signingKeyDir: ".keys",
  backupLocalDir: ".backups",
};

describe("启动闸门：NODE_ENV × DEPLOYMENT_ENV 四种组合", () => {
  it("组合 1｜NODE_ENV=development + DEPLOYMENT_ENV=development：只警告，不拦截", () => {
    withConfig(DEV_OK, () => {
      // 开发进程不校验生产密钥：带着开发默认值也不该产生 issue。
      expect(bootSafetyIssues()).toEqual([]);
      expect(bootMustFail(bootSafetyIssues())).toBe(false);
    });
  });

  it("组合 1 补充｜非生产进程即使有问题也只警告", () => {
    // 非法 DEPLOYMENT_ENV 会进 issues，但 NODE_ENV 不是 production，所以只警告。
    withConfig({ ...DEV_OK, deploymentEnv: "Sandbox" }, () => {
      const issues = bootSafetyIssues();
      expect(issues.some((i) => i.includes("DEPLOYMENT_ENV 只能是"))).toBe(true);
      expect(bootMustFail(issues)).toBe(false);
    });
  });

  it("组合 2｜NODE_ENV=production + DEPLOYMENT_ENV=production：正常通过", () => {
    withConfig(PROD_OK, () => {
      expect(bootSafetyIssues()).toEqual([]);
      expect(bootMustFail(bootSafetyIssues())).toBe(false);
    });
  });

  it("组合 3｜NODE_ENV=production + DEPLOYMENT_ENV=development：必须拦截", () => {
    withConfig(
      {
        ...DEV_OK,
        isProduction: true,
        // 生产构建跑在开发配置上，密钥也是开发默认值——阶段 1 之前的真实故障现场。
      },
      () => {
        const issues = bootSafetyIssues();
        expect(issues).toContain(
          "NODE_ENV=production 但 DEPLOYMENT_ENV 不是 production（当前是 development）：生产构建跑在开发配置上",
        );
        expect(issues).toContain("SESSION_SECRET 仍是开发默认值");
        expect(issues).toContain("LICENSE_HMAC_PEPPER 仍是开发默认值");
        expect(issues).toContain("BACKUP_ENCRYPTION_KEY 仍是开发默认值");
        expect(issues).toContain("DEV_MAIL_SINK 必须为 false");
        expect(bootMustFail(issues)).toBe(true);
      },
    );
  });

  it("组合 4｜NODE_ENV=production + DEPLOYMENT_ENV=production + 开发默认密钥：必须拦截", () => {
    withConfig(
      {
        ...PROD_OK,
        sessionSecret: "dev-only-session-secret-please-change-in-production-32bytes",
      },
      () => {
        const issues = bootSafetyIssues();
        expect(issues).toEqual(["SESSION_SECRET 仍是开发默认值"]);
        expect(bootMustFail(issues)).toBe(true);
      },
    );
  });

  it("沙箱（NODE_ENV=production + DEPLOYMENT_ENV=sandbox）不算「生产跑在开发配置上」", () => {
    // 现网 3101 就是这种组合：同一份生产构建 + 显式隔离部署。
    // 它不该因为这条新规则起不来；隔离性由 .keys/.backups 的专用规则保证。
    withConfig(
      {
        ...PROD_OK,
        deploymentEnv: "sandbox",
        signingKeyDir: ".keys-sandbox",
        backupLocalDir: ".backups-sandbox",
      },
      () => {
        expect(bootSafetyIssues()).toEqual([]);
        expect(bootMustFail(bootSafetyIssues())).toBe(false);
      },
    );
  });

  it("沙箱共用生产密钥目录时仍然要被拦（原有的隔离规则没被放宽）", () => {
    withConfig(
      {
        ...PROD_OK,
        deploymentEnv: "sandbox",
        signingKeyDir: ".keys",
        backupLocalDir: ".backups",
      },
      () => {
        const issues = bootSafetyIssues();
        expect(issues).toContain("Sandbox 的 SIGNING_KEY_DIR 不能与生产共用 .keys");
        expect(issues).toContain("Sandbox 的 BACKUP_LOCAL_DIR 不能与生产共用 .backups");
        expect(bootMustFail(issues)).toBe(true);
      },
    );
  });
});
