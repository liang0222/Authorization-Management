import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connection } from "next/server";
import { readPublicBaseUrls, rewriteServerDomainsInYaml } from "@/lib/developers/base-urls";

/**
 * GET /developers/openapi.yaml —— 直接下发契约文件本身。
 *
 * 为什么要走路由而不是把文件放进 public/：public 下的文件会在构建期被当成静态资源，
 * 而契约需要带正确的 content-type 与缓存策略，也不希望被 CDN 长期缓存导致客户端拿到旧契约。
 *
 * 下发的 `servers[].variables.domain.default` 会替换成本实例配置的真实域名：
 * 文件本身保持模板形态（同一个包部署到任何域名都不用改），但集成方 curl 下来的
 * 就是能直接用的地址。替换是定点文本替换，注释与排版原样保留。
 */
export async function GET() {
  await connection();
  const file = await readFile(join(process.cwd(), "public", "openapi", "openapi-v1.yaml"), "utf8");
  const { text } = rewriteServerDomainsInYaml(file, readPublicBaseUrls());
  return new Response(text, {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
