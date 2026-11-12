import { describe, expect, it } from "vitest";
import { DEV_DEFAULTS } from "@/lib/config";
import { checkProdEnv, hasFailure, isLocalOrPrivateHost, type EnvLike } from "@/lib/prod-env-check";

/**
 * `npm run check:prod-env` 的判定逻辑（阶段 2）。
 *
 * 两条底线要测住：
 * 1. 全默认值的 env 必须**每项都 FAIL**——否则上线前自检就给不出「还不能上线」的信号。
 * 2. 合规 env 必须**每项都 PASS**——否则这个脚本会被当成噪音直接忽略。
 *
 * 另外钉一条安全约定：输出里不允许出现密钥值或其片段（只断言 detail 不含原值即可）。
 */

/** 全默认值：直接用 config 的开发默认值当 env 文件内容。 */
const ALL_DEFAULTS: EnvLike = { ...DEV_DEFAULTS };

/** 合规生产配置：四把独立密钥、https 域名、独立密钥目录、关掉邮件回显。 */
const COMPLIANT: EnvLike = {
  SESSION_SECRET: "0123456789abcdef0123456789abcdef-session",
  LICENSE_HMAC_PEPPER: "0123456789abcdef0123456789abcdef-pepper",
  BACKUP_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef-backup",
  SECRETBOX_KEY: "0123456789abcdef0123456789abcdef-secretbox",
  DEPLOYMENT_ENV: "production",
  DEV_MAIL_SINK: "false",
  SIGNING_KEY_DIR: ".keys-prod",
  APP_BASE_URL: "https://license.example.com",
  LICENSE_DB_URL: "postgresql://licensing:strong_password_here@127.0.0.1:55432/licensing?schema=public",
};

describe("check:prod-env 判定", () => {
  it("全默认值：9 项全部 FAIL，且总体判为不通过", () => {
    const items = checkProdEnv(ALL_DEFAULTS);
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(item.status, `${item.name} 在默认值下应为 FAIL`).toBe("FAIL");
    }
    expect(hasFailure(items)).toBe(true);
  });

  it("合规配置：9 项全部 PASS，总体通过", () => {
    const items = checkProdEnv(COMPLIANT);
    const failed = items.filter((i) => i.status === "FAIL").map((i) => `${i.name}: ${i.detail}`);
    expect(failed).toEqual([]);
    expect(hasFailure(items)).toBe(false);
  });

  it("空 env（变量全不设）：同样全部 FAIL", () => {
    const items = checkProdEnv({});
    expect(items.every((i) => i.status === "FAIL")).toBe(true);
  });

  it("密钥项只报结论，不带密钥值或片段", () => {
    const items = checkProdEnv(COMPLIANT);
    const secretItems = ["SESSION_SECRET", "LICENSE_HMAC_PEPPER", "BACKUP_ENCRYPTION_KEY", "SECRETBOX_KEY"];
    for (const name of secretItems) {
      const item = items.find((i) => i.name === name)!;
      const value = COMPLIANT[name]!;
      expect(item.detail).not.toContain(value);
      expect(item.detail).not.toContain(value.slice(0, 8));
      expect(item.detail).not.toContain(String(value.length));
    }
  });

  it("数据库连接串不打印口令：用了开发口令就 FAIL，且 detail 里没有口令", () => {
    const item = checkProdEnv({ ...COMPLIANT, LICENSE_DB_URL: DEV_DEFAULTS.LICENSE_DB_URL }).find(
      (i) => i.name === "LICENSE_DB_URL",
    )!;
    expect(item.status).toBe("FAIL");
    expect(item.detail).toContain("开发默认口令");
    expect(item.detail).not.toContain("licensing_dev_pw");
    expect(item.detail).not.toContain("127.0.0.1");
  });

  it("数据库指向内网/公网都放行，但要写清 host 性质", () => {
    const lan = checkProdEnv({
      ...COMPLIANT,
      LICENSE_DB_URL: "postgresql://licensing:pw_strong_enough@10.20.30.40:5432/licensing",
    }).find((i) => i.name === "LICENSE_DB_URL")!;
    expect(lan.status).toBe("PASS");
    expect(lan.detail).toContain("本机/内网");

    const wan = checkProdEnv({
      ...COMPLIANT,
      LICENSE_DB_URL: "postgresql://licensing:pw_strong_enough@db.example.com:5432/licensing?sslmode=require",
    }).find((i) => i.name === "LICENSE_DB_URL")!;
    expect(wan.status).toBe("PASS");
    expect(wan.detail).toContain("非内网地址");
  });

  it("APP_BASE_URL 只有 https 才算过", () => {
    for (const value of ["https://license.example.com", "HTTPS://license.example.com"]) {
      expect(checkProdEnv({ ...COMPLIANT, APP_BASE_URL: value }).find((i) => i.name === "APP_BASE_URL")!.status).toBe(
        "PASS",
      );
    }
    for (const value of ["http://license.example.com", "license.example.com", ""]) {
      expect(checkProdEnv({ ...COMPLIANT, APP_BASE_URL: value }).find((i) => i.name === "APP_BASE_URL")!.status).toBe(
        "FAIL",
      );
    }
  });

  it("DEV_MAIL_SINK 必须显式为 false", () => {
    expect(checkProdEnv({ ...COMPLIANT, DEV_MAIL_SINK: "true" }).find((i) => i.name === "DEV_MAIL_SINK")!.status).toBe(
      "FAIL",
    );
    expect(checkProdEnv({ ...COMPLIANT, DEV_MAIL_SINK: undefined }).find((i) => i.name === "DEV_MAIL_SINK")!.status).toBe(
      "FAIL",
    );
  });

  it("SIGNING_KEY_DIR 不能还是开发共用的 .keys", () => {
    for (const value of [".keys", "./.keys", ""]) {
      expect(
        checkProdEnv({ ...COMPLIANT, SIGNING_KEY_DIR: value }).find((i) => i.name === "SIGNING_KEY_DIR")!.status,
      ).toBe("FAIL");
    }
  });

  it("isLocalOrPrivateHost 覆盖本机与私网段", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "0.0.0.0", "10.1.2.3", "192.168.1.9", "172.16.0.5", "172.31.255.1", "169.254.1.1", "fd12:3456::1"]) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
    for (const host of ["db.example.com", "8.8.8.8", "172.32.0.1", "11.0.0.1"]) {
      expect(isLocalOrPrivateHost(host), host).toBe(false);
    }
  });
});
