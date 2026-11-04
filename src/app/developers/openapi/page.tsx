import type { Metadata } from "next";
import { connection } from "next/server";
import { OpenApiExplorer } from "@/components/developers/openapi-explorer";

export const metadata: Metadata = { title: "在线 OpenAPI 浏览" };

/**
 * `cacheComponents` 开着的时候，页面里出现 `connection()` 会让路由变成阻塞式，
 * 不加这一行构建会直接失败（同 `/developers` 那四个页面）。
 */
export const instant = false;

/**
 * 在线 OpenAPI 浏览页。
 *
 * 数据源用**同源的** `/developers/openapi.yaml`，不是仓库里的静态文件——
 * 那条路由在响应时才把 `servers[].variables.domain.default` 换成本实例真实域名，
 * 所以这里看到的 Base URL 就是可直接调用的地址。
 */
export default async function OpenApiPage() {
  await connection();

  return <OpenApiExplorer specUrl="/developers/openapi.yaml" />;
}
