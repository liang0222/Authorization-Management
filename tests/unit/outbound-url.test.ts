import { describe, expect, it } from "vitest";

import {
  OUTBOUND_URL_MESSAGES,
  checkOutboundUrl,
  isBlockedAddress,
  isLoopbackHostname,
} from "@/lib/domain/outbound-url";

const DEV = { allowHttpLoopback: true };
const PROD = { allowHttpLoopback: false };

describe("地址段判定", () => {
  it("公网地址不拦", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.119.195.10", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("私网、回环、链路本地、CGNAT 都拦", () => {
    for (const ip of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "240.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("云元数据地址 169.254.169.254 必拦", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("IPv6 回环、ULA、链路本地、组播都拦", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("IPv4-mapped 与 NAT64 的内嵌地址也要判", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true);
  });

  it("解析不出来的字符串按危险处理", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("回调地址静态校验", () => {
  it("公网 https 放行", () => {
    expect(checkOutboundUrl("https://hooks.example.com/license", PROD)).toBeNull();
    expect(checkOutboundUrl("https://8.8.8.8/hook", PROD)).toBeNull();
  });

  it("内网 IP 字面量在生产和开发环境都拦", () => {
    for (const url of [
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00::1]/hook",
    ]) {
      expect(checkOutboundUrl(url, PROD), url).toBe("blocked_address");
      expect(checkOutboundUrl(url, DEV), url).toBe("blocked_address");
    }
  });

  it("回环 https 在开发环境放行、生产环境拦", () => {
    expect(checkOutboundUrl("https://127.0.0.1:8443/hook", DEV)).toBeNull();
    expect(checkOutboundUrl("https://127.0.0.1:8443/hook", PROD)).toBe("blocked_address");
  });

  it("http 只在开发环境对回环放行", () => {
    expect(checkOutboundUrl("http://localhost:4011/hook", DEV)).toBeNull();
    expect(checkOutboundUrl("http://127.0.0.1:4011/hook", DEV)).toBeNull();
    expect(checkOutboundUrl("http://localhost:4011/hook", PROD)).toBe("unsupported_protocol");
    expect(checkOutboundUrl("http://example.com/hook", DEV)).toBe("unsupported_protocol");
  });

  it("拒绝非 http(s) 协议与内嵌账密", () => {
    expect(checkOutboundUrl("file:///etc/passwd", DEV)).toBe("unsupported_protocol");
    expect(checkOutboundUrl("gopher://127.0.0.1:6379/_", DEV)).toBe("unsupported_protocol");
    expect(checkOutboundUrl("https://user:pw@example.com/hook", DEV)).toBe("credentials_in_url");
    expect(checkOutboundUrl("not a url", DEV)).toBe("invalid_url");
  });

  it("单标签主机名按内网短名拦掉", () => {
    expect(checkOutboundUrl("https://intranet/hook", DEV)).toBe("blocked_address");
    expect(checkOutboundUrl("https://metadata/hook", DEV)).toBe("blocked_address");
  });

  it("每个问题都有面向用户的中文说明", () => {
    for (const message of Object.values(OUTBOUND_URL_MESSAGES)) {
      expect(message.length).toBeGreaterThan(4);
    }
  });

  it("回环主机名识别覆盖 localhost 与方括号 IPv6", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});
