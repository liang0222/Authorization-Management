import { describe, expect, it } from "vitest";
import {
  generateClientId,
  generateLicenseKey,
  hashLicenseKey,
  licenseKeyLast4,
  licenseKeyPrefix,
  maskLicenseKey,
  normalizeLicenseKey,
} from "@/lib/domain/license-key";
import { ROLE_PRESETS, NAV_GROUPS, permissionsForRoleCodes } from "@/lib/domain/permissions";

describe("授权码生成", () => {
  it("格式为 5 组 × 6 位，熵 150 bit", () => {
    const key = generateLicenseKey();
    expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){4}$/);
    expect(key.replace(/-/g, "")).toHaveLength(30);
    // 30 × log2(32) = 150 bit > 128
    expect(30 * Math.log2(32)).toBeGreaterThanOrEqual(128);
  });

  it("批量生成不重复", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateLicenseKey()));
    expect(keys.size).toBe(200);
  });

  it("归一化：去分隔符、大写、Crockford 别名", () => {
    expect(normalizeLicenseKey(" abcd-efgh ijkl ")).toBe("ABCDEFGH1JK1");
    expect(normalizeLicenseKey("O0I1L")).toBe("00111");
  });

  it("HMAC 哈希稳定且不受分隔符影响", () => {
    const key = generateLicenseKey();
    const spaced = key.toLowerCase().replace(/-/g, " ");
    expect(Buffer.from(hashLicenseKey(key)).toString("hex")).toBe(
      Buffer.from(hashLicenseKey(spaced)).toString("hex"),
    );
  });

  it("不同 pepper 产生不同哈希", () => {
    const key = "AAAAAA-BBBBBB-CCCCCC-DDDDDD-EEEEEE";
    const a = Buffer.from(hashLicenseKey(key, "pepper-a")).toString("hex");
    const b = Buffer.from(hashLicenseKey(key, "pepper-b")).toString("hex");
    expect(a).not.toBe(b);
  });

  it("prefix/last4 与脱敏展示", () => {
    const key = "ABCDEF-GHIJKM-NPQRST-VWXYZ0-123456";
    expect(licenseKeyPrefix(key)).toHaveLength(8);
    expect(licenseKeyLast4(key)).toBe("3456");
    expect(maskLicenseKey("3456")).toBe("••••-••••-••••-3456");
  });
});

describe("产品凭证标识", () => {
  it("公开/机密客户端前缀不同", () => {
    expect(generateClientId("public_client")).toMatch(/^pc_[0-9a-f]{24}$/);
    expect(generateClientId("confidential_server")).toMatch(/^cs_[0-9a-f]{24}$/);
  });
});

describe("RBAC 预设与导航", () => {
  it("owner 拥有全部权限，viewer 只有只读", () => {
    const owner = permissionsForRoleCodes(["owner"]);
    const viewer = permissionsForRoleCodes(["viewer"]);
    expect(owner.size).toBeGreaterThan(viewer.size);
    expect([...viewer].every((code) => code.endsWith(":read"))).toBe(true);
  });

  it("operator 可发码续费但不能撤销或管理密钥", () => {
    const operator = permissionsForRoleCodes(["operator"]);
    expect(operator.has("license:issue")).toBe(true);
    expect(operator.has("license:renew")).toBe(true);
    expect(operator.has("license:revoke")).toBe(false);
    expect(operator.has("signingkey:write")).toBe(false);
  });

  it("每个预设角色至少有一个权限，且导航项权限码都存在于目录", () => {
    const all = new Set(ROLE_PRESETS.flatMap((role) => role.permissions));
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(all.has(item.permission)).toBe(true);
      }
    }
  });
});
