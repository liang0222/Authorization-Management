import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http/api";
import {
  assertEd25519PublicKey,
  deviceKeyThumbprint,
  rawToSpkiDer,
  spkiDerToRaw,
} from "@/lib/domain/signing-key";

/**
 * 公钥格式与校验（规格 4.5 / 4.13）。
 *
 * 这些断言保护的是「管理端登记机密服务端凭证公钥」这条入口：
 * 用户粘贴的公钥可能来自任意语言、任意导出方式，校验必须把「格式不对」
 * 稳定地报成 400，而不是让 `createPublicKey` 的原生异常冒泡成 500。
 */
function freshSpki(): Buffer {
  const pair = generateKeyPairSync("ed25519");
  return Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
}

describe("Ed25519 公钥格式（规格 4.5）", () => {
  it("标准导出的 SPKI DER 是 44 字节，裸公钥是 32 字节", () => {
    const der = freshSpki();
    expect(der.length).toBe(44);
    expect(spkiDerToRaw(der).length).toBe(32);
  });

  it("32 字节裸公钥包成 SPKI 后能被 Node 解析，且前 12 字节是固定头", () => {
    const der = freshSpki();
    const raw = spkiDerToRaw(der);
    const rebuilt = rawToSpkiDer(raw);
    expect(rebuilt.length).toBe(44);
    expect(rebuilt.subarray(0, 12).toString("hex")).toBe("302a300506032b6570032100");
    expect(rebuilt.equals(der)).toBe(true);
  });

  it("裸公钥长度不是 32 字节时报 400", () => {
    expect(() => rawToSpkiDer(Buffer.alloc(31))).toThrow(ApiError);
    expect(() => rawToSpkiDer(Buffer.alloc(33))).toThrow(ApiError);
  });

  it("长度够但内容不是 SPKI 时抛 400，而不是原生 Error（避免冒泡成 500）", () => {
    // 44 字节随机数据：长度合法、DER 结构非法。这正是管理端最容易被粘贴进来的输入。
    let caught: unknown;
    try {
      assertEd25519PublicKey(Buffer.alloc(44, 0x01));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).code).toBe("INVALID_REQUEST");
  });

  it("合法的 SPKI 通过校验", () => {
    expect(() => assertEd25519PublicKey(freshSpki())).not.toThrow();
  });
});

describe("设备公钥指纹（规格 4.13）", () => {
  it("同一份 raw 公钥的 base64url 与 base64 得到相同指纹", () => {
    const raw = spkiDerToRaw(freshSpki());
    const url = raw.toString("base64url");
    const std = raw.toString("base64");
    expect(deviceKeyThumbprint(url)).toBe(deviceKeyThumbprint(std));
  });

  it("指纹形如 sha256:<43 字符 base64url>", () => {
    const raw = spkiDerToRaw(freshSpki());
    const thumbprint = deviceKeyThumbprint(raw.toString("base64url"));
    expect(thumbprint.startsWith("sha256:")).toBe(true);
    expect(thumbprint.slice("sha256:".length)).toHaveLength(43);
  });

  it("不同公钥得到不同指纹", () => {
    const a = deviceKeyThumbprint(spkiDerToRaw(freshSpki()).toString("base64url"));
    const b = deviceKeyThumbprint(spkiDerToRaw(freshSpki()).toString("base64url"));
    expect(a).not.toBe(b);
  });
});
