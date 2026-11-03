import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  OUTBOUND_URL_MESSAGES,
  type OutboundUrlPolicy,
  checkOutboundUrl,
  safeLookup,
} from "@/lib/domain/outbound-url";

/**
 * 带 SSRF 防护的出站 POST。
 *
 * 为什么不用 `fetch`：
 * `fetch`（undici）在连接时自己解析 DNS，我们无法把「校验过的 IP」交给它，
 * 于是「校验时解析到公网、连接时解析到 127.0.0.1」这个窗口就关不上。
 * 这里用 `node:https` 的 `lookup` 钩子，把解析、校验、连接绑在同一次解析上。
 *
 * 其余安全默认：
 * - 不跟随重定向（`redirect` 语义等价于直接忽略 3xx）。
 * - 连接超时与整体超时分离，慢速攻击拖不死 worker。
 * - 响应体只读前 2KB 用于排错，不把对端返回的巨型 HTML 读进内存。
 */

export interface SafePostResult {
  /** HTTP 状态码；连接阶段失败时为 null。 */
  status: number | null;
  /** 失败原因（已脱敏，不含 URL 里的查询串）。 */
  error: string | null;
}

export interface SafePostOptions {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  policy: OutboundUrlPolicy;
  /** 只保留前 N 字节响应体用于日志；默认 2048。 */
  maxResponseBytes?: number;
}

export async function safePostJson(options: SafePostOptions): Promise<SafePostResult> {
  const { url, body, headers, timeoutMs, policy } = options;
  const maxResponseBytes = options.maxResponseBytes ?? 2048;

  // 静态校验先做一遍：IP 字面量、协议、内嵌账密在这一步就拦掉，
  // 不必等到 DNS 阶段。投递时再校验一次，是因为端点配置可能早于代码收紧。
  const problem = checkOutboundUrl(url, policy);
  if (problem) {
    return { status: null, error: `blocked_url:${problem}:${OUTBOUND_URL_MESSAGES[problem]}` };
  }

  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise<SafePostResult>((resolve) => {
    let settled = false;
    const finish = (result: SafePostResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requestFn(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        // 关键：解析与连接绑定，解析结果必须是公网地址。
        lookup: safeLookup(policy),
        // 关闭 keep-alive 之外的隐式行为，避免复用到被污染的连接池。
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let consumed = 0;
        res.on("data", (chunk: Buffer) => {
          consumed += chunk.length;
          if (consumed > maxResponseBytes) res.destroy();
        });
        res.on("end", () => finish({ status, error: null }));
        res.on("error", () => finish({ status, error: "response_stream_error" }));
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      // 不把对端地址写进错误串：错误会落进 webhook_deliveries.last_error 长期保存。
      const reason =
        error.code === "EACCES"
          ? "blocked_address"
          : error.code === "ENOTFOUND"
            ? "dns_not_found"
            : error.message === "timeout"
              ? "timeout"
              : (error.code ?? error.name);
      finish({ status: null, error: String(reason).slice(0, 120) });
    });

    req.end(body);
  });
}
