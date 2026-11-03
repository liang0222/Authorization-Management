#!/usr/bin/env node
/**
 * OpenAPI 契约 lint（规格 27.18 / 27.20：OpenAPI 端点与实际路由逐条一致，且可校验）。
 *
 * 与 `tests/unit/openapi.test.ts` 的分工：
 * - 单元测试守「路由 ↔ path 双向一致」「operationId 唯一」「$ref 可解析」；
 * - 本脚本额外守「文档自身质量」：schema 结构完整、required 都有定义、枚举非空、
 *   无真实凭证泄漏、YAML 与 JSON 深度一致、servers 覆盖生产与沙箱。
 *
 * 用法：`npm run lint:openapi`（CI 与本地都跑这一条）。
 * 退出码非 0 表示契约有问题，不要合并。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAML_PATH = join(root, "public", "openapi", "openapi-v1.yaml");
const JSON_PATH = join(root, "public", "openapi", "openapi-v1.json");

const METHODS = ["get", "post", "put", "patch", "delete"];

/** 真实凭证形态：一旦出现在公开文档里就是泄漏（占位符 <your-client-id> 不匹配）。 */
const SECRET_PATTERNS = [
  { name: "生产公开客户端 ID", re: /pc_desktop_[0-9a-f]{10,}/ },
  { name: "沙箱公开客户端 ID", re: /pc_sandbox_[0-9a-f]{10,}/ },
  { name: "机密服务端凭证 ID", re: /cs_(gateway|miniapp|sandbox)_[0-9a-f]{10,}/ },
  { name: "Webhook secret", re: /whsec_[A-Za-z0-9_-]{16,}/ },
  { name: "私钥", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

function walk(node, visit, where = "spec") {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, visit, `${where}[${index}]`));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value, `${where}.${key}`);
      walk(value, visit, `${where}.${key}`);
    }
  }
}

function resolveRef(spec, ref) {
  if (!ref.startsWith("#/")) return undefined;
  let cursor = spec;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    cursor = cursor?.[key];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

export function lintOpenApi() {
  const problems = [];
  const raw = readFileSync(YAML_PATH, "utf8");
  let spec;
  try {
    spec = parse(raw);
  } catch (error) {
    return [`YAML 解析失败：${error.message}`];
  }

  // 1. 版本与基本信息
  if (!/^3\.1\./.test(String(spec.openapi))) problems.push(`openapi 版本必须是 3.1.x，实际 ${spec.openapi}`);
  if (!spec.info?.title) problems.push("info.title 缺失");
  if (!spec.info?.version) problems.push("info.version 缺失");
  if (!spec.info?.description) problems.push("info.description 缺失（开发者需要知道这是哪个 API）");

  // 2. servers：生产与沙箱各一条，都必须 https，且默认域名不能共用一个
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  if (servers.length < 2) problems.push("servers 少于两条（规格 27.3 要求生产与沙箱各一条）");
  if (!servers.every((item) => String(item.url).startsWith("https://"))) {
    problems.push("servers 里有非 https 地址（生产必须 TLS）");
  }
  const serverDomain = (item) => item?.variables?.domain?.default ?? item?.url ?? "";
  const production = servers.find((item) => /production/i.test(item.description ?? ""));
  const sandbox = servers.find((item) => /sandbox/i.test(item.description ?? ""));
  if (!production) problems.push("servers 里没有标注 Production 的地址");
  if (!sandbox) problems.push("servers 里没有标注 Sandbox 的地址（规格 27.3 要求显式环境）");
  if (production && sandbox && serverDomain(production) === serverDomain(sandbox)) {
    problems.push("Production 与 Sandbox 的默认域名相同，SDK 无法区分环境");
  }

  // 3. 每个 path 至少一个操作，每个操作有 operationId / summary / responses / security
  const operationIds = new Set();
  const tags = new Set((spec.tags ?? []).map((tag) => tag.name));
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const operations = METHODS.filter((method) => item?.[method]);
    if (operations.length === 0) problems.push(`${path} 没有任何操作`);
    for (const method of operations) {
      const op = item[method];
      const label = `${method.toUpperCase()} ${path}`;
      if (!op.operationId) problems.push(`${label} 缺 operationId`);
      else if (operationIds.has(op.operationId)) problems.push(`${label} operationId 重复：${op.operationId}`);
      else operationIds.add(op.operationId);
      if (!op.summary) problems.push(`${label} 缺 summary`);
      if (!op.security?.length) problems.push(`${label} 未声明 security`);
      const codes = Object.keys(op.responses ?? {});
      if (!codes.some((code) => code.startsWith("2"))) problems.push(`${label} 没有 2xx 响应`);
      if (!codes.includes("default")) problems.push(`${label} 缺 default 错误响应`);
      for (const tag of op.tags ?? []) {
        if (tags.size > 0 && !tags.has(tag)) problems.push(`${label} 用了未声明的 tag：${tag}`);
      }
      for (const [code, response] of Object.entries(op.responses ?? {})) {
        // 响应体常写成 $ref 复用（BadRequest / RateLimited…），描述在引用目标里。
        const resolved = response?.$ref ? resolveRef(spec, response.$ref) : response;
        if (!resolved) {
          problems.push(`${label} 的 ${code} 响应 $ref 无法解析：${response?.$ref}`);
        } else if (!resolved.description) {
          problems.push(`${label} 的 ${code} 响应缺 description`);
        }
      }
    }
  }

  // 4. components.schemas：required 必须在 properties 里、enum 非空、object 要有属性
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    if (!schema || typeof schema !== "object") {
      problems.push(`schema ${name} 不是对象`);
      continue;
    }
    if (schema.$ref) {
      if (!resolveRef(spec, schema.$ref)) problems.push(`schema ${name} 的 $ref 无法解析：${schema.$ref}`);
      continue;
    }
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in properties)) problems.push(`schema ${name} 的 required 字段 ${key} 未定义`);
    }
    if (schema.type === "object" && Object.keys(properties).length === 0 && !schema.additionalProperties) {
      problems.push(`schema ${name} 是空 object，等于没有契约`);
    }
    if (Array.isArray(schema.enum) && schema.enum.length === 0) problems.push(`schema ${name} 的 enum 为空`);
    for (const [key, property] of Object.entries(properties)) {
      if (property?.$ref && !resolveRef(spec, property.$ref)) {
        problems.push(`schema ${name}.${key} 的 $ref 无法解析：${property.$ref}`);
      }
      if (property?.type === "array" && !property.items) {
        problems.push(`schema ${name}.${key} 是数组但没有 items`);
      }
    }
  }

  // 5. 凭证泄漏
  walk(spec, (key, value, where) => {
    if (typeof value !== "string") return;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(value)) problems.push(`${where} 疑似泄漏凭证（${name}）`);
    }
  });

  // 6. YAML 与 JSON 必须同步（文档中心提供两份下载，不能只更新一份）
  let json;
  try {
    json = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  } catch (error) {
    problems.push(`openapi-v1.json 解析失败：${error.message}（运行 npm run openapi:json 重新生成）`);
  }
  if (json) {
    const a = JSON.stringify(spec, Object.keys(spec).sort());
    const b = JSON.stringify(json, Object.keys(json).sort());
    if (a !== b) problems.push("openapi-v1.json 与 openapi-v1.yaml 内容不一致（运行 npm run openapi:json）");
  }

  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = lintOpenApi();
  if (problems.length === 0) {
    console.log("✓ OpenAPI lint 通过：结构、schema、servers、凭证泄漏、YAML/JSON 同步全部正常");
    process.exit(0);
  }
  console.error(`✗ OpenAPI lint 发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
