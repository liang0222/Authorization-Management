import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOW_INSECURE_BACKUP_HTTP,
  evaluateInsecureHttpTarget,
  parseEndpoint,
} from "@/lib/services/backup/insecure-http";

/**
 * 阶段 4：备份目标「明文 http」双重确认护栏。
 *
 * 这组测试守的是一条真实事故线：生产里只要把 tls_verify 设成 false，
 * 任何 http 端点都会被放行，于是 Basic Auth 口令长期明文过网。
 * 下面每条用例都对应一个具体的放行/拦截场景，正反例都有。
 */

const PROD = "production";
const PUBLIC_IP = "http://96.62.250.65:5244/dav";

function decide(overrides: Partial<Parameters<typeof evaluateInsecureHttpTarget>[0]> = {}) {
  return evaluateInsecureHttpTarget({
    deploymentEnv: PROD,
    endpointUrl: PUBLIC_IP,
    tlsVerify: false,
    allowEnvValue: null,
    ...overrides,
  });
}

describe("明文 http 判定：不涉及的端点一律放行", () => {
  it("https 端点不涉及明文", () => {
    const result = decide({ endpointUrl: "https://dav.example.com/backups" });
    expect(result.isHttp).toBe(false);
    expect(result.plaintext).toBe(false);
    expect(result.allowed).toBe(true);
    expect(result.needsAudit).toBe(false);
  });

  it("SFTP 端点不涉及明文", () => {
    const result = decide({ endpointUrl: "sftp://127.0.0.1:19022" });
    expect(result.isHttp).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it("本地目录（没有 endpoint）不涉及明文", () => {
    const result = decide({ endpointUrl: null });
    expect(result.isHttp).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it("endpoint 写坏了不会被当成 http 卡住（交给适配器报配置错误）", () => {
    const result = decide({ endpointUrl: "不是地址" });
    expect(result.isHttp).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it("endpoint 解析能取到主机名", () => {
    expect(parseEndpoint(PUBLIC_IP)).toEqual({ protocol: "http", hostname: "96.62.250.65" });
    expect(parseEndpoint("http://[::1]:9000")).toEqual({ protocol: "http", hostname: "[::1]" });
  });
});

describe("明文 http 判定：回环地址不受限", () => {
  it.each([
    "http://127.0.0.1:19080/dav",
    "http://localhost:19080/dav",
    "http://127.0.0.53:19080/dav",
    "http://[::1]:19080/dav",
    "http://0.0.0.0:19080/dav",
    "http://nas.localhost/dav",
  ])("%s 在生产下照旧可用，且不需要确认", (endpointUrl) => {
    const result = decide({ endpointUrl, tlsVerify: true, allowEnvValue: null });
    expect(result.loopback).toBe(true);
    expect(result.plaintext).toBe(false);
    expect(result.allowed).toBe(true);
    expect(result.needsAudit).toBe(false);
  });
});

describe("明文 http 判定：生产 + 非回环必须双重确认", () => {
  it("只有 tlsVerify=false、没有环境变量 → 拒绝，原因点名缺环境变量", () => {
    const result = decide({ tlsVerify: false, allowEnvValue: null });
    expect(result.plaintext).toBe(true);
    expect(result.targetConfirmed).toBe(true);
    expect(result.envConfirmed).toBe(false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(ALLOW_INSECURE_BACKUP_HTTP);
    expect(result.reason).not.toContain("tls_verify=false 与");
  });

  it("只有环境变量、没有 tlsVerify=false → 拒绝，原因点名缺目标确认", () => {
    const result = decide({ tlsVerify: true, allowEnvValue: "true" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("tls_verify=false");
  });

  it("两个都没有 → 拒绝，原因同时点名两项", () => {
    const result = decide({ tlsVerify: true, allowEnvValue: null });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("tls_verify=false");
    expect(result.reason).toContain(ALLOW_INSECURE_BACKUP_HTTP);
  });

  it("双重确认齐全 → 放行，且要求写审计", () => {
    const result = decide({ tlsVerify: false, allowEnvValue: "true" });
    expect(result.allowed).toBe(true);
    expect(result.needsAudit).toBe(true);
  });

  it.each(["TRUE", "True", "1", "yes", " true", ""])("环境变量写成 %o 不算确认", (value) => {
    const result = decide({ tlsVerify: false, allowEnvValue: value });
    expect(result.envConfirmed).toBe(false);
    expect(result.allowed).toBe(false);
  });

  it("S3 兼容端点同样是 http 时也受同一规则约束（不是只拦 WebDAV）", () => {
    const result = decide({ endpointUrl: "http://s3.public.example:9000", tlsVerify: false, allowEnvValue: null });
    expect(result.plaintext).toBe(true);
    expect(result.allowed).toBe(false);
  });
});

describe("明文 http 判定：非生产环境维持原行为", () => {
  it.each(["development", "sandbox"])("%s 下放行，但如实标出 plaintext", (deploymentEnv) => {
    const result = decide({ deploymentEnv, tlsVerify: false, allowEnvValue: null });
    expect(result.allowed).toBe(true);
    expect(result.plaintext).toBe(true);
    expect(result.needsAudit).toBe(false);
  });
});

describe("明文 http 判定：默认从进程环境读确认开关", () => {
  const original = process.env[ALLOW_INSECURE_BACKUP_HTTP];
  afterEach(() => {
    if (original === undefined) delete process.env[ALLOW_INSECURE_BACKUP_HTTP];
    else process.env[ALLOW_INSECURE_BACKUP_HTTP] = original;
  });

  it("不传 allowEnvValue 时读 process.env", () => {
    process.env[ALLOW_INSECURE_BACKUP_HTTP] = "true";
    const allowed = evaluateInsecureHttpTarget({ deploymentEnv: PROD, endpointUrl: PUBLIC_IP, tlsVerify: false });
    expect(allowed.allowed).toBe(true);

    process.env[ALLOW_INSECURE_BACKUP_HTTP] = "false";
    const blocked = evaluateInsecureHttpTarget({ deploymentEnv: PROD, endpointUrl: PUBLIC_IP, tlsVerify: false });
    expect(blocked.allowed).toBe(false);
  });
});
