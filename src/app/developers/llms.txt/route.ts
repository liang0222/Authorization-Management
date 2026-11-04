import { connection } from "next/server";
import { buildLlmsIndex } from "@/lib/developers/llms-generator";

/**
 * GET /developers/llms.txt —— 给 AI 助手的索引文件（规格 27.17）。
 *
 * 正文在请求时从 OpenAPI 契约与代码常量生成，不做静态缓存：
 * 契约变了却因为缓存继续下发旧端点表，比慢几毫秒严重得多。
 *
 * `connection()` 不是装饰：基础地址来自运行实例的环境变量（`PUBLIC_API_BASE_URL`），
 * 构建机上没有这些值，预渲染会把「未配置」烤进产物。
 */
export async function GET() {
  await connection();
  return new Response(buildLlmsIndex(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
