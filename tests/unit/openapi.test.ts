import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * OpenAPI 契约测试（增量指令要求「不得把 OpenAPI 文件能解析误报为已和后端契约一致」）。
 *
 * 这里做的是**结构层面的双向核对**：spec 里写的每个 path 必须在代码里有对应 route.ts，
 * 反过来公开 API 目录下的每个 route.ts 也必须在 spec 里有定义。字段级语义由集成测试覆盖。
 */

const root = process.cwd();
const specPath = join(root, "public", "openapi", "openapi-v1.yaml");
const apiRoot = join(root, "src", "app", "api", "v1");

type Operation = {
  operationId?: string;
  summary?: string;
  security?: unknown[];
  responses?: Record<string, unknown>;
  parameters?: Array<{ $ref?: string }>;
};

const raw = readFileSync(specPath, "utf8");
const spec = parse(raw) as {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  servers: Array<{ url: string }>;
};

/** `/activations/{activation_id}/entitlements` → `activations/[activation_id]/entitlements` */
function specPathToRouteDir(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^\{(.+)\}$/, "[$1]"))
    .join("/");
}

/** 收集公开 API 目录下所有 route.ts（排除管理端与自身认证）。 */
function collectPublicRoutes(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // 只排除顶层 admin/ 与 auth/：它们是管理后台私有接口，不进公开 OpenAPI。
    if (dir === apiRoot && (entry === "admin" || entry === "auth")) continue;
    // /api/v1/status 是公开健康检查，不属于 SDK 契约（无 X-Client-ID、无业务语义），
    // 单独在 /developers/status 文档化，不进 OpenAPI。
    if (dir === apiRoot && entry === "status") continue;
    if (existsSync(join(full, "route.ts"))) out.push(`${prefix}/${entry}`);
    out.push(...collectPublicRoutes(full, `${prefix}/${entry}`));
  }
  return out;
}

describe("OpenAPI 契约", () => {
  it("是 OpenAPI 3.1 文档并带服务器地址", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.servers.length).toBeGreaterThan(0);
    expect(spec.servers[0].url).toContain("/api/v1");
  });

  it("每个 path 都有真实路由文件", () => {
    const missing: string[] = [];
    for (const path of Object.keys(spec.paths)) {
      const routeFile = join(apiRoot, specPathToRouteDir(path), "route.ts");
      if (!existsSync(routeFile)) missing.push(`${path} → ${routeFile}`);
    }
    expect(missing, `spec 里存在但代码里没有的端点：\n${missing.join("\n")}`).toEqual([]);
  });

  it("每个公开路由都被 spec 覆盖", () => {
    // 代码里的动态段是 `[activation_id]`，spec 里是 `{activation_id}`，比较前先归一化。
    const documented = new Set(
      Object.keys(spec.paths).map((path) => `/api/v1${path}`.replace(/\/$/, "")),
    );
    const normalize = (route: string) => route.replace(/\[([^\]]+)\]/g, "{$1}");
    const undocumented = collectPublicRoutes(apiRoot, "/api/v1")
      .map(normalize)
      .filter((route) => !documented.has(route));
    expect(undocumented, `代码里存在但 spec 未覆盖的公开端点：\n${undocumented.join("\n")}`).toEqual(
      [],
    );
  });

  it("operationId 唯一且每个操作都声明了响应与错误", () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(op.operationId, `${method.toUpperCase()} ${path} 缺 operationId`).toBeTruthy();
        ids.push(op.operationId as string);
        const codes = Object.keys(op.responses ?? {});
        expect(codes.length, `${method.toUpperCase()} ${path} 没有 responses`).toBeGreaterThan(0);
        // 每个操作都要说明它的失败长什么样，否则 SDK 无法生成错误类型。
        expect(codes, `${method.toUpperCase()} ${path} 缺错误响应`).toContain("default");
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("所有 $ref 都能解析", () => {
    const problems: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, `${where}[${index}]`));
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === "$ref" && typeof value === "string") {
            const [file, pointer] = value.split("#");
            if (file) {
              problems.push(`${where}: 外部引用 ${value} 不允许`);
              continue;
            }
            const segments = pointer
              .split("/")
              .slice(1)
              .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
            let cursor: unknown = spec;
            for (const segment of segments) {
              cursor = (cursor as Record<string, unknown> | undefined)?.[segment];
              if (cursor === undefined) {
                problems.push(`${where}: ${value} 无法解析`);
                break;
              }
            }
          }
          walk(value, `${where}.${key}`);
        }
      }
    };
    walk(spec, "spec");
    expect(problems).toEqual([]);
  });

  it("每个操作都声明了安全方案", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(
          Array.isArray(op.security) && op.security.length > 0,
          `${method.toUpperCase()} ${path} 未声明 security`,
        ).toBe(true);
      }
    }
  });

  it("生成的 JSON 与 YAML 内容一致", () => {
    const json = JSON.parse(
      readFileSync(join(root, "public", "openapi", "openapi-v1.json"), "utf8"),
    ) as typeof spec;
    expect(Object.keys(json.paths).sort()).toEqual(Object.keys(spec.paths).sort());
    expect(json.info.version).toBe(spec.info.version);
  });
});
