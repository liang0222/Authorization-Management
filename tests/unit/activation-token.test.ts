import { describe, expect, it } from "vitest";
import {
  canonicalChallengeMessage,
  issueActivationToken,
  verifyActivationToken,
} from "@/lib/domain/activation-token";

const payload = {
  aid: "11111111-1111-4111-8111-111111111111",
  did: "22222222-2222-4222-8222-222222222222",
  pid: "33333333-3333-4333-8333-333333333333",
  org: "44444444-4444-4444-8444-444444444444",
  ver: 3,
};

describe("激活访问令牌", () => {
  it("签发后可验证，载荷一致", () => {
    const { token } = issueActivationToken(payload, 600);
    const result = verifyActivationToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.aid).toBe(payload.aid);
      expect(result.payload.ver).toBe(3);
    }
  });

  it("篡改载荷签名失效", () => {
    const { token } = issueActivationToken(payload, 600);
    const [body, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, ver: 99 }),
    ).toString("base64url");
    expect(verifyActivationToken(`${forged}.${signature}`).ok).toBe(false);
    expect(verifyActivationToken(`${body}.${signature}x`).ok).toBe(false);
  });

  it("过期令牌被拒绝", () => {
    const { token } = issueActivationToken(payload, -1);
    const result = verifyActivationToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("空值与畸形输入不抛异常", () => {
    expect(verifyActivationToken(null).ok).toBe(false);
    expect(verifyActivationToken("abc").ok).toBe(false);
    expect(verifyActivationToken("a.b.c").ok).toBe(false);
  });
});

describe("挑战规范化消息", () => {
  it("字段顺序固定且以换行分隔（SDK 必须一致）", () => {
    const message = canonicalChallengeMessage({
      challengeId: "c1",
      nonce: "n1",
      productId: "p1",
      deviceInstanceId: "d1",
      expiresAt: "2026-11-02T00:00:00Z",
    });
    expect(message).toBe("c1\nn1\np1\nd1\n2026-11-02T00:00:00Z");
  });
});
