import { describe, expect, it } from "vitest";
import {
  PUBLIC_API_ENV,
  PUBLIC_SANDBOX_ENV,
  applyServerDomains,
  displayBaseUrl,
  hostOf,
  originOf,
  rewriteServerDomainsInYaml,
  type PublicBaseUrls,
} from "@/lib/developers/base-urls";

/**
 * 文档站基础地址（规格 27.20 第 ⑥ 条：文档必须说明 Production / Sandbox Base URL）。
 *
 * 这组断言守的是两件事：
 * 1. 未配置时**明说未配置并给出环境变量名**，绝不编一个像真的域名；
 * 2. 配置了就如实渲染，且契约文件的注释/排版不被破坏。
 */

const CONFIGURED: PublicBaseUrls = {
  production: "https://licensing.example.com",
  sandbox: "https://sandbox.licensing.example.com",
};
const EMPTY: PublicBaseUrls = { production: null, sandbox: null };

const SPEC = {
  openapi: "3.1.0",
  servers: [
    {
      url: "https://{domain}/api/v1",
      description: "Production",
      variables: { domain: { default: "license-api.example.com" } },
    },
    {
      url: "https://{domain}/api/v1",
      description: "Sandbox（独立数据库、独立签名密钥、独立产品凭证）",
      variables: { domain: { default: "sandbox-license-api.example.com" } },
    },
  ],
};

const YAML = `openapi: 3.1.0
info:
  title: demo
servers:
  # 这两条注释必须原样保留：下载契约的人靠它理解语义
  - url: https://{domain}/api/v1
    description: Production
    variables:
      domain:
        default: license-api.example.com
  - url: https://{domain}/api/v1
    description: Sandbox
    variables:
      domain:
        default: sandbox-license-api.example.com
`;

describe("displayBaseUrl / hostOf / originOf", () => {
  it("已配置时原样输出", () => {
    expect(displayBaseUrl(CONFIGURED.production, PUBLIC_API_ENV)).toBe("https://licensing.example.com");
    expect(hostOf(CONFIGURED.sandbox, PUBLIC_SANDBOX_ENV)).toBe("sandbox.licensing.example.com");
    expect(originOf(CONFIGURED.production, PUBLIC_API_ENV)).toBe("https://licensing.example.com");
  });

  it("未配置时明说未配置并带上环境变量名，不编默认域名", () => {
    expect(displayBaseUrl(null, PUBLIC_API_ENV)).toContain("未配置");
    expect(displayBaseUrl(null, PUBLIC_API_ENV)).toContain(PUBLIC_API_ENV);
    expect(hostOf(null, PUBLIC_SANDBOX_ENV)).toContain(PUBLIC_SANDBOX_ENV);
    expect(originOf(null, PUBLIC_API_ENV)).toContain(PUBLIC_API_ENV);
  });

  it("配置了带端口/路径的地址时 host 与 origin 各自正确", () => {
    const url = "https://api.example.com:8443/api/v1";
    expect(hostOf(url, PUBLIC_API_ENV)).toBe("api.example.com:8443");
    expect(originOf(url, PUBLIC_API_ENV)).toBe("https://api.example.com:8443");
  });

  it("非法地址不抛异常，退化为原字符串", () => {
    expect(hostOf("not a url", PUBLIC_API_ENV)).toBe("not a url");
    expect(originOf("not a url", PUBLIC_API_ENV)).toBe("not a url");
  });
});

describe("applyServerDomains", () => {
  it("按 description 分别替换 Production 与 Sandbox 的域名", () => {
    const patched = applyServerDomains(SPEC, CONFIGURED);
    expect(patched.servers[0].variables?.domain?.default).toBe("licensing.example.com");
    expect(patched.servers[1].variables?.domain?.default).toBe("sandbox.licensing.example.com");
  });

  it("未配置时保留模板默认值，不写入空串", () => {
    const patched = applyServerDomains(SPEC, EMPTY);
    expect(patched.servers[0].variables?.domain?.default).toBe("license-api.example.com");
    expect(patched.servers[1].variables?.domain?.default).toBe("sandbox-license-api.example.com");
  });

  it("不改原对象（纯函数）", () => {
    applyServerDomains(SPEC, CONFIGURED);
    expect(SPEC.servers[0].variables.domain.default).toBe("license-api.example.com");
  });

  it("没有 servers 时原样返回", () => {
    const spec = { openapi: "3.1.0" };
    expect(applyServerDomains(spec, CONFIGURED)).toEqual(spec);
  });

  it("带端口的域名取 host（含端口）", () => {
    const patched = applyServerDomains(SPEC, {
      production: "https://licensing.example.com:8443",
      sandbox: "https://sandbox.example.com:8443",
    });
    expect(patched.servers[0].variables?.domain?.default).toBe("licensing.example.com:8443");
  });
});

describe("rewriteServerDomainsInYaml", () => {
  it("替换两处默认域名，且注释与排版原样保留", () => {
    const { text, replaced } = rewriteServerDomainsInYaml(YAML, CONFIGURED);
    expect(replaced).toBe(2);
    expect(text).toContain("default: licensing.example.com");
    expect(text).toContain("default: sandbox.licensing.example.com");
    expect(text).toContain("# 这两条注释必须原样保留");
    expect(text).not.toContain("license-api.example.com");
  });

  it("未配置时不动文件", () => {
    const { text, replaced } = rewriteServerDomainsInYaml(YAML, EMPTY);
    expect(replaced).toBe(0);
    expect(text).toBe(YAML);
  });

  it("非法 YAML 原样返回，不抛", () => {
    const broken = "openapi: [unclosed";
    expect(rewriteServerDomainsInYaml(broken, CONFIGURED)).toEqual({ text: broken, replaced: 0 });
  });
});
