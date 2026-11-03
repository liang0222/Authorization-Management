import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * GET /developers/openapi.yaml —— 直接下发契约文件本身。
 *
 * 为什么要走路由而不是把文件放进 public/：public 下的文件会在构建期被当成静态资源，
 * 而契约需要带正确的 content-type 与缓存策略，也不希望被 CDN 长期缓存导致客户端拿到旧契约。
 */
export async function GET() {
  const file = await readFile(join(process.cwd(), "public", "openapi", "openapi-v1.yaml"), "utf8");
  return new Response(file, {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
