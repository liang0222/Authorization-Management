/**
 * 备份目标出站地址校验（SSRF）。
 *
 * 连接测试与真实备份都由服务端发起请求：WebDAV/S3 可以填任意 URL，
 * 如果不校验，`http://169.254.169.254/...` 这类地址就会让服务器替调用方访问云元数据。
 *
 * 复用 Webhook 的同一套策略（`checkOutboundUrl`）：
 * - 只允许 http/https；生产只允许 https，开发环境仅放行回环；
 * - 拒绝 IP 字面量落在私网/回环/链路本地/ULA/组播段；
 * - 拒绝单标签内网短名（如 `metadata`）；
 * - 拒绝 URL 内嵌账密。
 *
 * SFTP 的 endpoint 不是 URL（可能只是 `host` 或 `sftp://host:port`），这里单独解析主机名：
 * 能静态判定的 IP 字面量与单标签短名先拦掉；DNS 解析到内网的情况由连接层负责，
 * 但至少不会把明显的 `127.0.0.1`、`10.x`、`[fd00::1]` 存进配置。
 */
import { isIP } from "node:net";

import { ApiError } from "@/lib/http/api";
import {
  OUTBOUND_URL_MESSAGES,
  checkOutboundUrl,
  isBlockedAddress,
  type OutboundUrlPolicy,
} from "@/lib/domain/outbound-url";

export interface BackupEndpointInput {
  providerType: string;
  endpointUrl?: string | null;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, "INVALID_REQUEST", message, { fieldErrors: { [field]: message } });
}

export function assertBackupEndpointAllowed(input: BackupEndpointInput, policy: OutboundUrlPolicy): void {
  const raw = input.endpointUrl?.trim();
  if (!raw) return;

  if (input.providerType === "webdav" || input.providerType === "s3") {
    const problem = checkOutboundUrl(raw, policy);
    if (problem) throw invalid("endpointUrl", OUTBOUND_URL_MESSAGES[problem]);
    return;
  }

  if (input.providerType !== "sftp") return;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `sftp://${raw}`);
  } catch {
    throw invalid("endpointUrl", "SFTP 主机地址不是合法的 URL");
  }
  if (url.protocol !== "sftp:") {
    throw invalid("endpointUrl", "SFTP 主机地址只支持 sftp:// 协议");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw invalid("endpointUrl", "SFTP 主机指向内网、回环或链路本地地址，出于安全考虑被拒绝");
    }
    return;
  }
  if (!host.includes(".")) {
    throw invalid("endpointUrl", "SFTP 主机名不能是单标签内网短名");
  }
}
