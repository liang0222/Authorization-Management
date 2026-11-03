import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GET /developers/ai-integration-prompt.md —— 给 AI 编程工具的接入提示词（规格 27.17 第 5 条）。
 *
 * 正文的唯一来源是仓库里的 `docs/ai-integration-prompt.md`：只维护一份，
 * 避免「文档改了、对外那份没改」。这里不做静态缓存，改完文件刷新即可看到。
 */
export async function GET() {
  let body: string;
  try {
    body = readFileSync(join(process.cwd(), "docs", "ai-integration-prompt.md"), "utf8");
  } catch {
    // 部署时漏带 docs/ 目录时给出可诊断的说明，而不是 500。
    body = "# AI 接入提示词暂不可用\n\n服务端未找到 docs/ai-integration-prompt.md，请检查部署产物是否包含 docs 目录。\n";
  }

  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
