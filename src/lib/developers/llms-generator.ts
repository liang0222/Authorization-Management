import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DOCS_SECTIONS, MACHINE_READABLE_FILES } from "@/lib/developers/docs-nav";
import { ERROR_STATUS } from "@/lib/http/api";
import { PUBLIC_RATE_LIMITS } from "@/lib/domain/public-rate-limits";
import { WEBHOOK_EVENT_TYPES } from "@/lib/services/webhook-events";

/**
 * `llms.txt` / `llms-full.txt` 的生成器（规格 27.17）。
 *
 * 为什么不再手写：这两个文件是给 AI 编程工具读的，一旦和真实契约脱节，
 * AI 会照着过时的端点列表写代码 —— 报错信息看起来像「客户端写错了」，
 * 实际是文档没跟上。所以能派生的部分一律派生：
 *
 * | 内容 | 来源 |
 * | --- | --- |
 * | 端点清单与摘要 | `public/openapi/openapi-v1.yaml` 的 `paths` |
 * | 错误码与 HTTP 状态 | `src/lib/http/api.ts` 的 `ERROR_STATUS` |
 * | 限流数值 | `src/lib/domain/public-rate-limits.ts` 的 `PUBLIC_RATE_LIMITS` |
 * | Webhook 事件 | `src/lib/services/webhook-events.ts` 的 `WEBHOOK_EVENT_TYPES` |
 * | 推荐阅读顺序 | `src/lib/developers/docs-nav.ts` 的 `DOCS_SECTIONS` |
 * | 机器可读文件 | `src/lib/developers/docs-nav.ts` 的 `MACHINE_READABLE_FILES` |
 *
 * 剩下手写的是「讲解性文字」（响应信封长什么样、重试策略怎么定），
 * 那部分本来就没有机器可读的真源。
 *
 * 铁律：这里只写公开契约事实，绝不出现真实域名、凭证、授权码、私钥或任何密钥。
 * 测试 `tests/unit/llms.test.ts` 会扫描生成结果里的密钥样式，防止有人手滑写进来。
 */

export const API_BASE_PLACEHOLDER = "https://<LICENSE_API_DOMAIN>/api/v1";
export const SANDBOX_BASE_PLACEHOLDER = "https://<LICENSE_SANDBOX_API_DOMAIN>/api/v1";

export const LLMS_INDEX_PATH = "/developers/llms.txt";
export const LLMS_FULL_PATH = "/developers/llms-full.txt";

interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
}

interface OpenApiDocument {
  info?: { version?: string; title?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  tags?: Array<{ name: string; description?: string }>;
}

const HTTP_METHOD_ORDER = ["get", "post", "put", "patch", "delete"] as const;

export interface EndpointFact {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  deprecated: boolean;
}

let cachedSpec: OpenApiDocument | null = null;

/** 读契约文件本身：`public/openapi/openapi-v1.yaml` 是唯一事实来源。 */
export function loadOpenApiDocument(): OpenApiDocument {
  if (cachedSpec) return cachedSpec;
  const file = readFileSync(join(process.cwd(), "public", "openapi", "openapi-v1.yaml"), "utf8");
  cachedSpec = parseYaml(file) as OpenApiDocument;
  return cachedSpec;
}

/** 把 `paths` 拍平成有序端点清单（同一 path 内按 GET→POST 顺序）。 */
export function endpointsFromSpec(spec: OpenApiDocument = loadOpenApiDocument()): EndpointFact[] {
  const facts: EndpointFact[] = [];
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    const methods = Object.keys(operations).filter((key) =>
      (HTTP_METHOD_ORDER as readonly string[]).includes(key),
    );
    methods.sort(
      (a, b) =>
        HTTP_METHOD_ORDER.indexOf(a as (typeof HTTP_METHOD_ORDER)[number]) -
        HTTP_METHOD_ORDER.indexOf(b as (typeof HTTP_METHOD_ORDER)[number]),
    );
    for (const method of methods) {
      const operation = operations[method];
      facts.push({
        method: method.toUpperCase(),
        path,
        summary: operation.summary?.trim() ?? "",
        tags: operation.tags ?? [],
        deprecated: operation.deprecated === true,
      });
    }
  }
  return facts;
}

/** `/activations/{activation_id}/entitlements` → `activations/entitlements`，对齐限流表的键。 */
function rateLimitKeyFor(path: string): string {
  return path
    .replace(/^\//, "")
    .replace(/\/\{[^}]+\}\//g, "/")
    .replace(/\{[^}]+\}/g, "");
}

/**
 * 端点行刻意**不做列对齐**：`- POST /activations` 这种单空格形式才能被
 * `grep "GET /activations/{activation_id}"` 原样命中，也能被测试直接断言。
 * 为了好看多补两个空格，换来的是每次搜索都要猜空格数量。
 */
function endpointLines(spec: OpenApiDocument): string[] {
  return endpointsFromSpec(spec).map((fact) => {
    const marker = fact.deprecated ? "（已弃用）" : "";
    const summary = fact.summary ? `  ${fact.summary}` : "";
    return `- ${fact.method} ${fact.path}${marker}${summary}`;
  });
}

function rateLimitLines(): string[] {
  return Object.entries(PUBLIC_RATE_LIMITS).map(([route, rule]) => {
    const label = route === "default" ? "其他端点" : `/${route}`;
    return `- ${label}  ${rule.limit} 次 / ${rule.windowSeconds} 秒`;
  });
}

function errorCodeLines(): string[] {
  // 按状态码分组，读起来比 19 行平铺清楚；同状态码内按字母序稳定输出。
  const grouped = new Map<number, string[]>();
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    const bucket = grouped.get(status) ?? [];
    bucket.push(code);
    grouped.set(status, bucket);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, codes]) => `- ${status}：${codes.sort().join(" / ")}`);
}

/** 只暴露给公开调用方的那部分错误码：MFA_REQUIRED / CSRF_FAILED 属于控制台登录流程。 */
const ADMIN_ONLY_CODES = new Set(["MFA_REQUIRED", "CSRF_FAILED", "CONFLICT"]);

function publicErrorCodeLines(): string[] {
  const grouped = new Map<number, string[]>();
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    if (ADMIN_ONLY_CODES.has(code)) continue;
    const bucket = grouped.get(status) ?? [];
    bucket.push(code);
    grouped.set(status, bucket);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, codes]) => `- ${status}：${codes.sort().join(" / ")}`);
}

function readingOrderLines(): string[] {
  let index = 0;
  return DOCS_SECTIONS.flatMap((section) =>
    section.items.map((item) => {
      index += 1;
      return `${index}. ${item.href}  ${item.title} —— ${item.description}`;
    }),
  );
}

function machineReadableLines(): string[] {
  return MACHINE_READABLE_FILES.map((file) => `- ${file.path}  ${file.description}`);
}

/** 索引文件：给 AI 一个「读什么、别踩什么坑」的入口。 */
export function buildLlmsIndex(spec: OpenApiDocument = loadOpenApiDocument()): string {
  const version = spec.info?.version ?? "unknown";
  return [
    "# 子铭软件授权 API",
    "",
    "> 软件授权管理平台对外公开的 HTTP API。用于激活软件、校验授权、读取功能权限、接收状态变更事件。",
    `> 契约版本 ${version}；本文件由 \`public/openapi/openapi-v1.yaml\` 与代码常量生成，不是手写副本。`,
    "",
    "## 阅读顺序",
    "",
    ...readingOrderLines(),
    "",
    "## 核心约束（违反会直接失败）",
    "",
    "- 公开客户端只带 X-Client-ID + 设备 Ed25519 签名，禁止内置任何 Secret。",
    "- 写操作必须带 Idempotency-Key（激活强制）。",
    "- 分支判断用 code，不要用 message 或 HTTP 状态码。",
    "- 只重试网络错误 / 408 / 429 / 5xx；400/401/403/410/422/423 不要重试。",
    "- refresh_token 每次心跳轮换，收到新值必须先落盘。",
    "- 日志里不得出现完整授权码、令牌或签名原文。",
    "",
    "## 端点",
    "",
    ...endpointLines(spec),
    "",
    "## 机器可读文件",
    "",
    ...machineReadableLines(),
    "",
  ].join("\n");
}

/** 完整文本：索引 + 请求约定 + 逐端点详述 + 状态/错误/限流/Webhook。 */
export function buildLlmsFull(spec: OpenApiDocument = loadOpenApiDocument()): string {
  const version = spec.info?.version ?? "unknown";
  const tagDescriptions = (spec.tags ?? [])
    .filter((tag) => tag.description)
    .map((tag) => `- ${tag.name}：${tag.description}`);

  return [
    "# 子铭软件授权 API · 完整契约",
    "",
    `本文件是公开文档的纯文本合并版，供 AI 助手直接读取。契约版本 ${version}，` +
      "端点、错误码、限流与事件清单均从代码与 OpenAPI 契约派生，不含任何真实凭证。",
    "",
    "## 1. 基础地址",
    "",
    `Production : ${API_BASE_PLACEHOLDER}`,
    `Sandbox    : ${SANDBOX_BASE_PLACEHOLDER}`,
    "",
    "Sandbox 与生产使用独立数据库、独立签名密钥、独立产品凭证与独立限流命名空间。",
    "任何 SDK 或客户端都不得把生产域名写成默认值。",
    "",
    "## 2. 公共请求约定",
    "",
    "- 始终使用 TLS。",
    "- Content-Type: application/json；Accept: application/json。",
    "- 必带 X-Client-ID（公开客户端标识，不是密钥）。",
    "- 可选 X-SDK-Version、X-Client-Platform、X-Request-Id。",
    "- 写操作带 Idempotency-Key；同一 key + 同一请求体视为重试，返回原结果并加响应头 x-idempotent-replay: true。",
    "- 令牌只放 Authorization: Bearer，不放 URL，不进日志。",
    "- 连接超时 3–5 秒，读取超时 5–15 秒。",
    "",
    "## 3. 响应信封",
    "",
    "成功：",
    '{ "ok": true, "code": "OK", "message": "成功", "request_id": "req_...", "server_time": "ISO8601", "data": { } }',
    "",
    "失败：",
    '{ "ok": false, "code": "ERROR_CODE", "message": "人类可读说明", "request_id": "req_...", "server_time": "ISO8601" }',
    "",
    "request_id 是排障唯一线索；server_time 用于校正本地时钟偏差。",
    "",
    "## 4. 认证",
    "",
    "| 接入形态 | 认证方式 |",
    "| --- | --- |",
    "| EXE / 桌面客户端 | X-Client-ID + 设备私钥签名（Ed25519） |",
    "| 浏览器扩展 | 公开客户端方式；强授权请放自有后端 |",
    "| 微信小程序 | 只调自有后端，不直连本 API |",
    "| 网站 / 小程序后端 | private_key_jwt（client_assertion），或 mTLS |",
    "",
    "X-Client-ID 会出现在客户端二进制里，因此它不是密钥，也不能用来做权限判定。",
    "",
    "## 5. 规范化挑战消息（v1）",
    "",
    "LICENSE-ACTIVATION-CHALLENGE-V1\\n",
    "{challenge_id}\\n",
    "{nonce}\\n",
    "{product_id}\\n",
    "{device_instance_id}\\n",
    "{expires_at}",
    "",
    "除最后一行外每行一个 LF（0x0A），末尾不额外加 LF。签名算法首版固定 Ed25519，" +
      "公钥与签名均为 Base64URL 无填充。nonce 一次性消费，挑战 5 分钟有效。",
    "",
    "建议直接对响应里的 canonical_message 字段签名，不要自己拼字符串。",
    "",
    "## 6. 端点",
    "",
    ...tagDescriptions,
    "",
    ...endpointLines(spec),
    "",
    "每个端点的请求/响应字段以 openapi.yaml 为准；下表只列「有哪些端点、属于哪一组」。",
    "",
    "## 7. 有效状态优先级",
    "",
    "product_disabled > revoked > cancelled > suspended > draft > activation_window_expired > not_yet_valid > expired > active",
    "",
    "activation_limit_reached 与 device_limit_reached 只影响新的激活，不影响已激活设备继续使用。",
    "",
    "## 8. 错误码",
    "",
    ...publicErrorCodeLines(),
    "",
    "## 9. 重试",
    "",
    "应重试：网络错误、408、429（按 Retry-After）、500、503。指数退避 + 抖动，最多 3 次。",
    "不重试：400、401、403、410、422、423。401 若因 access_token 过期，可用 refresh_token 换新后重试一次，仅一次。",
    "",
    "## 10. 限流（固定窗口，按产品/组织/IP 三层计数）",
    "",
    ...rateLimitLines(),
    "",
    "响应头：RateLimit-Limit、RateLimit-Remaining、RateLimit-Reset（秒）。429 另带 Retry-After。",
    "",
    "## 11. Webhook",
    "",
    `事件（共 ${WEBHOOK_EVENT_TYPES.length} 个）：`,
    "",
    ...WEBHOOK_EVENT_TYPES.map((event) => `- ${event}`),
    "",
    "请求头：X-License-Event-Id、X-License-Event-Type、X-License-Timestamp、X-License-Signature: v1=<hex hmac_sha256>",
    "签名原文：{timestamp}.{raw_request_body}（原始字节，不是重新序列化的 JSON）",
    "校验：时间窗 5 分钟、恒时比较、按 event_id 去重。",
    "重试：30s / 2m / 8m / 32m / 2h / 死信；单次超时 10 秒；只有 5xx 与 429 重试。",
    "",
    "## 12. 版本策略",
    "",
    "URL 主版本 /api/v1；同主版本只做向后兼容增加；破坏性变更走 /api/v2。",
    `OpenAPI info.version 是规范版本（${version}），不是 API 版本。`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 仅供测试使用

export const __internal = { errorCodeLines, publicErrorCodeLines, rateLimitKeyFor, endpointLines };
