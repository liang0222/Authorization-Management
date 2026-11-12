import { describe, expect, it } from "vitest";

import {
  evaluateAuthzAlert,
  evaluateLoginAlert,
  redactAlertPayload,
  redactAlertText,
} from "@/lib/domain/security-alerts";

describe("安全告警阈值判定", () => {
  it("登录失败未达阈值不告警（IP 9 次、邮箱 9 次、2 个 IP）", () => {
    expect(evaluateLoginAlert({ ipFailures: 9, emailFailures: 9, distinctIps: 2 })).toEqual([]);
  });

  it("同一 IP 10 次失败触发 ip 维度", () => {
    expect(evaluateLoginAlert({ ipFailures: 10, emailFailures: 1, distinctIps: 1 })).toEqual(["ip"]);
  });

  it("同一邮箱 10 次失败但只有 2 个 IP 时不单独告警", () => {
    expect(evaluateLoginAlert({ ipFailures: 2, emailFailures: 10, distinctIps: 2 })).toEqual([]);
  });

  it("同一邮箱跨 3 个 IP 且失败 10 次触发 email 维度", () => {
    expect(evaluateLoginAlert({ ipFailures: 2, emailFailures: 10, distinctIps: 3 })).toEqual(["email"]);
  });

  it("IP 与邮箱两个维度同时越线时一起返回", () => {
    expect(evaluateLoginAlert({ ipFailures: 10, emailFailures: 10, distinctIps: 3 })).toEqual([
      "ip",
      "email",
    ]);
  });

  it("越权 19 次不告警，20 次按账号或 IP 维度触发", () => {
    expect(evaluateAuthzAlert({ actorEvents: 19, ipEvents: 19 })).toEqual([]);
    expect(evaluateAuthzAlert({ actorEvents: 20, ipEvents: 1 })).toEqual(["actor"]);
    expect(evaluateAuthzAlert({ actorEvents: 1, ipEvents: 20 })).toEqual(["ip"]);
    expect(evaluateAuthzAlert({ actorEvents: 20, ipEvents: 20 })).toEqual(["actor", "ip"]);
  });

  it("阈值可由调用方覆盖，边界仍按 >= 判断", () => {
    const thresholds = {
      loginFailuresPerIp: 3,
      loginFailuresPerEmail: 5,
      loginEmailDistinctIps: 2,
    };
    expect(
      evaluateLoginAlert({ ipFailures: 2, emailFailures: 4, distinctIps: 2, thresholds }),
    ).toEqual([]);
    expect(
      evaluateLoginAlert({ ipFailures: 3, emailFailures: 5, distinctIps: 2, thresholds }),
    ).toEqual(["ip", "email"]);
  });
});

describe("告警报文脱敏", () => {
  it("按键名丢弃密码、token、授权头、会话与密钥字段", () => {
    const input = {
      event: "auth.login_bruteforce",
      email: "owner@example.com",
      ip: "203.0.113.9",
      password: "License#2026",
      nested: {
        token: "abc",
        authorization: "Bearer xyz",
        accessKey: "AKIA...",
        license_key: "LIC-123",
        session: "sess",
        keep: "ok",
      },
    };
    const output = redactAlertPayload(input) as Record<string, unknown>;
    expect(output.password).toBeUndefined();
    expect(output.email).toBe("owner@example.com");
    expect(output.ip).toBe("203.0.113.9");
    const nested = output.nested as Record<string, unknown>;
    expect(nested.token).toBeUndefined();
    expect(nested.authorization).toBeUndefined();
    expect(nested.accessKey).toBeUndefined();
    expect(nested.license_key).toBeUndefined();
    expect(nested.session).toBeUndefined();
    expect(nested.keep).toBe("ok");
  });

  it("文本中的 password=/token=/Bearer 也会被擦除", () => {
    expect(redactAlertText("password=hunter2 token=abc keep=1")).toBe(
      "password=[redacted] token=[redacted] keep=1",
    );
    expect(redactAlertText("Authorization: Bearer eyJhbGciOi.abc.def")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactAlertText("https://example.com/cb?token=secret&x=1")).toBe(
      "https://example.com/cb?token=[redacted]&x=1",
    );
  });

  it("普通错误文案与失败目标名保持可读", () => {
    expect(redactAlertText("备份失败：连接超时（10.0.0.5）")).toBe("备份失败：连接超时（10.0.0.5）");
    const payload = redactAlertPayload({
      error_message: "S3 PutObject 403",
      failed_targets: ["nightly-s3"],
    }) as Record<string, unknown>;
    expect(payload.error_message).toBe("S3 PutObject 403");
    expect(payload.failed_targets).toEqual(["nightly-s3"]);
  });
});
