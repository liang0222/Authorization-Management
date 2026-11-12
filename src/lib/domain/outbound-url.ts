import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP } from "node:net";

/**
 * 出站地址安全校验（规格 24 Go-Live Gate「Webhook 有 SSRF 防护」）。
 *
 * 两个使用点：
 * 1. 保存 Webhook 端点时做静态校验（`assertSafeWebhookUrl`）——语法层先拦一道。
 * 2. 真正投递时做 DNS 解析后校验（`safeLookup`）——挡住「保存时是公网域名、
 *    投递时解析到 127.0.0.1 / 169.254.169.254」的 DNS rebinding 与内网探测。
 *
 * 静态校验单独用是不够的：域名解析结果可以随时改。所以投递链路必须把
 * **解析结果**再验一次，并且让 socket 直接用这个已校验的 IP 建连，
 * 避免「校验用一个 IP、连接用另一个 IP」的检查/使用分离（TOCTOU）。
 */

/** 明确禁止的 IPv4 网段：[网络地址, 前缀长度]。 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // 本网络
  ["10.0.0.0", 8], // 私网 A
  ["100.64.0.0", 10], // CGNAT（云厂商内网常用）
  ["127.0.0.0", 8], // 回环
  ["169.254.0.0", 16], // 链路本地：含 169.254.169.254 云元数据
  ["172.16.0.0", 12], // 私网 B
  ["192.0.0.0", 24], // IETF 协议分配
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // 私网 C
  ["198.18.0.0", 15], // 基准测试
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // 组播
  ["240.0.0.0", 4], // 保留 + 广播
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inV4Cidr(ip: string, network: string, prefix: number): boolean {
  const value = v4ToInt(ip);
  const base = v4ToInt(network);
  if (value === null || base === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

/** 把 IPv6 文本展开成 8 个 16 位分组；无法解析返回 null。 */
function expandV6(ip: string): number[] | null {
  let text = ip;
  // 去掉 zone id（fe80::1%eth0）
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (text.toLowerCase().startsWith("::ffff:") && isIP(text.slice(7)) === 4) {
    const v4 = v4ToInt(text.slice(7));
    if (v4 === null) return null;
    return [0, 0, 0, 0, 0, 0xffff, (v4 >>> 16) & 0xffff, v4 & 0xffff];
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (segment: string): number[] | null => {
    if (segment === "") return [];
    const out: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

function v6PrefixMatch(groups: number[], prefixGroups: number[], prefixBits: number): boolean {
  let remaining = prefixBits;
  for (let i = 0; i < prefixGroups.length && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (prefixGroups[i] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/**
 * 这个地址是否属于「不允许作为回调目标」的范围。
 * 回环由调用方按环境决定是否放行（开发环境允许 http://localhost）。
 */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return BLOCKED_V4.some(([network, prefix]) => inV4Cidr(ip, network, prefix));
  }
  if (version !== 6) return true; // 解析不出来的一律当危险地址

  const groups = expandV6(ip);
  if (!groups) return true;

  // IPv4-mapped / NAT64：取出内嵌 IPv4 再按 IPv4 规则判
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  // 64:ff9b::/96 NAT64
  if (v6PrefixMatch(groups, [0x0064, 0xff9b, 0, 0, 0, 0], 96)) {
    const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    return isBlockedAddress(v4);
  }

  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if (v6PrefixMatch(groups, [0xfc00], 7)) return true; // ULA fc00::/7
  if (v6PrefixMatch(groups, [0xfe80], 10)) return true; // 链路本地
  if (v6PrefixMatch(groups, [0xff00], 8)) return true; // 组播
  if (v6PrefixMatch(groups, [0x2001, 0x0db8], 32)) return true; // 文档用
  return false;
}

export interface OutboundUrlPolicy {
  /** 允许 http 协议（仅开发环境对回环地址开放）。 */
  allowHttpLoopback: boolean;
}

export type OutboundUrlProblem =
  | "invalid_url"
  | "unsupported_protocol"
  | "credentials_in_url"
  | "blocked_address";

export const OUTBOUND_URL_MESSAGES: Record<OutboundUrlProblem, string> = {
  invalid_url: "地址不是合法的 URL",
  unsupported_protocol: "地址必须是 https（开发环境允许 http://localhost）",
  credentials_in_url: "地址里不能包含账号密码",
  blocked_address: "地址指向内网、回环或云元数据地址，出于安全考虑被拒绝",
};

/**
 * 静态校验一个出站地址。不解析 DNS——DNS 解析在投递时用 `safeLookup` 再验一次。
 *
 * 拒绝：
 * - 非 http/https 协议
 * - URL 内嵌账密（会被写进日志与投递记录）
 * - IP 字面量落在私网/回环/链路本地/元数据/组播段
 * - 单标签主机名（`http://intranet/` 这类内网短名，只能靠内部 DNS 解析）
 */
export function checkOutboundUrl(raw: string, policy: OutboundUrlPolicy): OutboundUrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.username || url.password) return "credentials_in_url";

  const isHttps = url.protocol === "https:";
  const isHttp = url.protocol === "http:";
  if (!isHttps && !isHttp) return "unsupported_protocol";

  // URL.hostname 对 IPv6 会带方括号
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = isLoopbackHostname(hostname);

  // 回环地址单独处理：开发策略下放行（含 http），生产一律拒绝。
  // 放在 IP 字面量与单标签主机名判断之前，因为 localhost 两者都不是。
  //
  // 例外：IPv6 回环字面量 `[::1]` 即使在开发环境也不放行。本地联调只需要
  // `localhost` / `127.0.0.1`；把字面量 `::1` 也放开，会让「回环放行」这条策略
  // 多出一个不必要的外部可指定地址面（同时也避免测试把 `[::1]` 当成本机夹具）。
  if (loopback || isLoopbackAddress(hostname)) {
    if (isIP(hostname) === 6 && isLoopbackAddress(hostname)) return "blocked_address";
    if (isHttp && !policy.allowHttpLoopback) return "unsupported_protocol";
    return policy.allowHttpLoopback ? null : "blocked_address";
  }

  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    // 非回环的 IP 字面量：私网、链路本地、元数据段一律拦。
    // 地址判断放在协议判断之前：`http://10.0.0.5` 报「内网地址」比报
    // 「必须是 https」更准确，也避免调用方误以为是证书/协议配置问题。
    if (isBlockedAddress(hostname)) return "blocked_address";
    if (!isHttps) return "unsupported_protocol";
    return null;
  }

  // 单标签主机名只能靠内网 DNS 解析，公网回调不该出现。
  // 同样放在协议判断之前，保证 `http://metadata` 得到的是「内网」而不是协议提示。
  if (!hostname.includes(".")) return "blocked_address";
  if (isHttp) return "unsupported_protocol";

  return null;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function isLoopbackAddress(hostname: string): boolean {
  if (isIP(hostname) === 0) return false;
  const groups = isIP(hostname) === 4 ? null : expandV6(hostname);
  if (isIP(hostname) === 4) {
    const value = v4ToInt(hostname);
    // 127.0.0.0/8
    return value !== null && (value >>> 24) === 127;
  }
  return Boolean(groups && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1);
}

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

/**
 * 给 `net.connect` / `https.request` 用的 lookup：
 * 解析出的**每一个**地址都必须通过校验，否则整次连接失败。
 * socket 随后直接连这个已校验的 IP，不做第二次解析——这就是防 DNS rebinding 的关键。
 */
export function safeLookup(policy: OutboundUrlPolicy) {
  return function lookup(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void {
    // `family` 在实际调用里是数字，但 Node 的类型声明允许 "IPv4"/"IPv6" 字符串。
    const family = typeof options.family === "number" ? options.family : 0;
    dnsLookup(hostname, { all: true, family }, (error, addresses) => {
      if (error) {
        callback(error, "");
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        const err: NodeJS.ErrnoException = new Error(`无法解析主机 ${hostname}`);
        err.code = "ENOTFOUND";
        callback(err, "");
        return;
      }
      for (const entry of list) {
        const allowLoopback = policy.allowHttpLoopback && isLoopbackHostname(hostname);
        if (isBlockedAddress(entry.address) && !allowLoopback) {
          const err: NodeJS.ErrnoException = new Error(
            `拒绝连接到非公网地址 ${entry.address}（SSRF 防护）`,
          );
          err.code = "EACCES";
          callback(err, "");
          return;
        }
      }
      if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      else (callback as unknown as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
    });
  };
}
