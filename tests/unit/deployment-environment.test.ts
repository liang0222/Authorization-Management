import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_ENVS,
  credentialEnvironmentFor,
  isIsolatedEnvironment,
} from "@/lib/domain/deployment-environment";
import { bootSafetyIssues } from "@/instrumentation";
import { config } from "@/lib/config";

describe("部署环境 → 凭证池映射（规格 27.3）", () => {
  it("sandbox 用沙箱池", () => {
    expect(credentialEnvironmentFor("sandbox")).toBe("sandbox");
  });

  it("production 与 development 共用生产池", () => {
    // development 是「本地跑生产代码」，必须能验通现网 client_id；
    // 真隔离要靠 DEPLOYMENT_ENV=sandbox 起独立实例。
    expect(credentialEnvironmentFor("production")).toBe("production");
    expect(credentialEnvironmentFor("development")).toBe("production");
  });

  it("未知取值不会意外进入沙箱池", () => {
    // 打错字（如 "Sandbox"、"sbx"）必须落到生产池而不是悄悄放宽；
    // 同时 productionSafetyIssues() 会把非法值报出来。
    expect(credentialEnvironmentFor("Sandbox")).toBe("production");
    expect(credentialEnvironmentFor("")).toBe("production");
  });

  it("只有 sandbox 被视为隔离环境", () => {
    expect(isIsolatedEnvironment("sandbox")).toBe(true);
    expect(isIsolatedEnvironment("production")).toBe(false);
    expect(isIsolatedEnvironment("development")).toBe(false);
  });

  it("环境枚举与规格一致", () => {
    expect([...DEPLOYMENT_ENVS]).toEqual(["production", "sandbox", "development"]);
  });
});

describe("启动闸门 bootSafetyIssues", () => {
  it("当前进程环境（development）必须通过，且凭证池是 production", () => {
    expect(config.deploymentEnv).toBe("development");
    expect(config.credentialEnvironment).toBe("production");
    expect(bootSafetyIssues()).toEqual([]);
  });

  it("沙箱不得与生产共用 .keys 与 .backups", () => {
    // 直接改运行时快照再还原：这些字段是 as const 对象，但对象本身可变引用。
    const snapshot = { ...config } as Record<string, unknown>;
    const mutable = config as unknown as Record<string, unknown>;
    mutable.deploymentEnv = "sandbox";
    mutable.signingKeyDir = ".keys";
    mutable.backupLocalDir = ".backups";
    try {
      const issues = bootSafetyIssues();
      expect(issues).toContain("Sandbox 的 SIGNING_KEY_DIR 不能与生产共用 .keys");
      expect(issues).toContain("Sandbox 的 BACKUP_LOCAL_DIR 不能与生产共用 .backups");
    } finally {
      Object.assign(mutable, snapshot);
    }
  });

  it("沙箱用自己的目录时不再报错", () => {
    const snapshot = { ...config } as Record<string, unknown>;
    const mutable = config as unknown as Record<string, unknown>;
    mutable.deploymentEnv = "sandbox";
    mutable.signingKeyDir = ".keys-sandbox";
    mutable.backupLocalDir = ".backups-sandbox";
    try {
      expect(bootSafetyIssues()).toEqual([]);
    } finally {
      Object.assign(mutable, snapshot);
    }
  });
});
