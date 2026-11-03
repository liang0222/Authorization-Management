#!/usr/bin/env node
/**
 * 由 `public/openapi/openapi-v1.yaml` 生成等价的 JSON。
 *
 * 为什么不在页面里实时转：`/developers/openapi.json` 要能被 SDK 生成器直接 curl 下来，
 * 由构建期生成静态文件最稳，也避免运行时多一次解析。
 * YAML 是唯一事实来源，JSON 是派生产物——两者不一致时以 YAML 为准。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "public", "openapi", "openapi-v1.yaml");
const target = join(root, "public", "openapi", "openapi-v1.json");

const spec = parse(readFileSync(source, "utf8"));
writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
console.log(
  `[openapi] 已生成 ${target} —— ${Object.keys(spec.paths ?? {}).length} 个 path，${Object.keys(spec.components?.schemas ?? {}).length} 个 schema`,
);
