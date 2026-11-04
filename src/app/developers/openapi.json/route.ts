import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connection } from "next/server";
import { applyServerDomains, readPublicBaseUrls } from "@/lib/developers/base-urls";

/**
 * GET /developers/openapi.json —— 与 YAML 同源的 JSON 版本（构建期由脚本生成）。
 *
 * JSON 是机器消费的，直接解析后覆盖 `servers[].variables.domain.default` 即可，
 * 不存在「注释会被冲掉」的问题。
 */
export async function GET() {
  await connection();
  const file = await readFile(join(process.cwd(), "public", "openapi", "openapi-v1.json"), "utf8");
  let body = file;
  try {
    const spec = JSON.parse(file) as Parameters<typeof applyServerDomains>[0];
    body = `${JSON.stringify(applyServerDomains(spec, readPublicBaseUrls()), null, 2)}\n`;
  } catch {
    body = file;
  }
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
