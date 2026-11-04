import { describe, expect, it } from "vitest";
import {
  contractInfo,
  findManifestSecretLeaks,
  parseSemver,
  satisfiesRange,
  validateManifest,
} from "@/lib/installer/manifest";
import { licensingSaasManifest } from "@/lib/installer/adapters/licensing-saas/manifest";
import { CONTRACT_VERSION, INSTALLER_VERSION } from "@/lib/installer/contract";
import type { ProjectManifest } from "@/lib/installer/contract";

/** 深拷贝，避免用例之间互相污染。 */
function clone(): ProjectManifest {
  return JSON.parse(JSON.stringify(licensingSaasManifest)) as ProjectManifest;
}

describe("semver 与版本区间", () => {
  it("解析三位版本号", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("10.0.0")).toEqual([10, 0, 0]);
  });

  it("非法版本号返回 null，前缀 v 与预发布后缀可接受", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("abc")).toBeNull();
  });

  it("空格分隔的 AND 约束", () => {
    expect(satisfiesRange("1.0.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("1.9.9", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesRange("0.9.9", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("单边约束", () => {
    expect(satisfiesRange("3.1.4", ">=3.0.0")).toBe(true);
    expect(satisfiesRange("2.9.0", ">=3.0.0")).toBe(false);
  });

  it("精确匹配与比较符", () => {
    expect(satisfiesRange("1.0.0", "=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.1", "=1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.1", ">1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "<=1.0.0")).toBe(true);
  });

  it("无法解析的约束一律判为不满足（宁可拒绝）", () => {
    expect(satisfiesRange("1.0.0", "~1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "1.0.0 || 2.0.0")).toBe(false);
    expect(satisfiesRange("bad", ">=1.0.0")).toBe(false);
  });
});

describe("Manifest 结构校验", () => {
  it("项目自带的 Manifest 通过校验", () => {
    const result = validateManifest(licensingSaasManifest);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("项目 id 不允许大写与路径分隔符（防穿越）", () => {
    for (const id of ["Bad-Id", "../escape", "a/b", "-leading", "with space"]) {
      const m = clone();
      m.project.id = id;
      expect(validateManifest(m).ok, id).toBe(false);
    }
  });

  it("字段 key 只允许标识符形态", () => {
    const m = clone();
    m.fields.admin[0].key = "../etc/passwd";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("successRedirect 必须是站内绝对路径", () => {
    for (const target of ["login", "//evil.example.com", "https://evil.example.com", ""]) {
      const m = clone();
      m.successRedirect = target;
      expect(validateManifest(m).ok, target).toBe(false);
    }
    const ok = clone();
    ok.successRedirect = "/login?next=%2Fapp";
    expect(validateManifest(ok).ok).toBe(true);
  });

  it("accentColor 必须是 6 位十六进制", () => {
    const m = clone();
    m.project.accentColor = "#fff";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("数据库类型只接受受支持的枚举", () => {
    const m = clone();
    (m.database as unknown as { type: string }).type = "oracle";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("至少要有一个管理员字段", () => {
    const m = clone();
    m.fields.admin = [];
    expect(validateManifest(m).ok).toBe(false);
  });

  it("字段 key 在同一组内不能重复", () => {
    const m = clone();
    m.fields.admin.push({ ...m.fields.admin[0] });
    expect(validateManifest(m).ok).toBe(false);
  });

  it("select 类型必须给 options", () => {
    const m = clone();
    const field = m.fields.system.find((f) => f.type === "select");
    expect(field).toBeDefined();
    delete field!.options;
    expect(validateManifest(m).ok).toBe(false);
  });
});

describe("Manifest 秘密泄漏检查（规格：禁止写入密码类秘密）", () => {
  it("secret 字段不允许带默认值", () => {
    const m = clone();
    const password = m.fields.admin.find((f) => f.key === "password")!;
    password.default = "License#2026";
    const leaks = findManifestSecretLeaks(m);
    expect(leaks.length).toBeGreaterThan(0);
    expect(validateManifest(m).ok).toBe(false);
  });

  it("任意字段的默认值里出现 token 形态会被抓出来", () => {
    for (const value of [
      "ghp_0123456789abcdefghijklmnopqrstuvwx",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ]) {
      const m = clone();
      m.fields.system[0].default = value;
      expect(findManifestSecretLeaks(m).length, value).toBeGreaterThan(0);
    }
  });

  it("不写 secret 但字段名暗示密码时也不允许给默认值", () => {
    const m = clone();
    m.fields.database.push({ key: "apiSecret", label: "API 密钥", type: "text", default: "plain-value-here" });
    expect(findManifestSecretLeaks(m).length).toBeGreaterThan(0);
  });

  it("项目自带的 Manifest 零泄漏", () => {
    expect(findManifestSecretLeaks(licensingSaasManifest)).toEqual([]);
  });
});

describe("contractInfo", () => {
  it("返回版本三元组，且安装器版本落在自身要求的区间内", () => {
    const info = contractInfo();
    expect(info.installerVersion).toBe(INSTALLER_VERSION);
    expect(info.contractVersion).toBe(CONTRACT_VERSION);
    expect(info.manifestVersion).toBe(licensingSaasManifest.manifestVersion);
    expect(satisfiesRange(INSTALLER_VERSION, licensingSaasManifest.requiresInstaller)).toBe(true);
  });
});
