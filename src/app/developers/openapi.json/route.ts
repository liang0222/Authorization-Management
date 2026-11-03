import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** GET /developers/openapi.json —— 与 YAML 同源的 JSON 版本（构建期由脚本生成）。 */
export async function GET() {
  const file = await readFile(join(process.cwd(), "public", "openapi", "openapi-v1.json"), "utf8");
  return new Response(file, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
