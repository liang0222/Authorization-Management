import { describe, expect, it } from "vitest";
import { openWithKeys, sealWithKey } from "@/lib/auth/secretbox";

describe("secretbox 密钥环", () => {
  it("用同一个密钥可以解回原文", () => {
    const sealed = sealWithKey("key-a", "MFA-SECRET-123");
    expect(openWithKeys(["key-a"], sealed)).toBe("MFA-SECRET-123");
  });

  it("轮换后旧密文仍可解（新密钥在前，旧密钥兜底）", () => {
    const sealed = sealWithKey("old-key", "whsec_legacy");
    expect(openWithKeys(["new-key", "old-key"], sealed)).toBe("whsec_legacy");
  });

  it("每次加密的 IV 不同，同一明文得到不同密文", () => {
    expect(sealWithKey("k", "same")).not.toBe(sealWithKey("k", "same"));
  });

  it("密钥全不匹配时抛错，不返回空串", () => {
    const sealed = sealWithKey("key-a", "x");
    expect(() => openWithKeys(["key-b"], sealed)).toThrow();
  });

  it("跳过空密钥与重复密钥", () => {
    const sealed = sealWithKey("key-a", "y");
    expect(openWithKeys(["", "key-a", "key-a"], sealed)).toBe("y");
  });

  it("密文被篡改时抛错（GCM 认证失败）", () => {
    const sealed = sealWithKey("key-a", "z");
    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() => openWithKeys(["key-a"], raw.toString("base64"))).toThrow();
  });
});
