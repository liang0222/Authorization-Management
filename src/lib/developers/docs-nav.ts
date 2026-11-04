/**
 * 公开开发者文档的导航结构（规格 27.2）。
 *
 * 单独放一份数据而不是写死在组件里：侧栏、面包屑、`llms.txt` 索引、上一页/下一页
 * 都要用同一份顺序，分散在四个地方手写必然漂移。
 */

export interface DocsNavItem {
  title: string;
  href: string;
  description: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

export const DOCS_SECTIONS: DocsNavSection[] = [
  {
    title: "开始",
    items: [
      { title: "概览", href: "/developers", description: "这套 API 能做什么、怎么读文档" },
      { title: "快速开始", href: "/developers/quickstart", description: "15 分钟内跑通第一次激活" },
      { title: "核心概念", href: "/developers/concepts", description: "授权、激活、设备、权限位" },
    ],
  },
  {
    title: "接入",
    items: [
      { title: "认证", href: "/developers/authentication", description: "四种客户端各自的认证方式" },
      { title: "API 参考", href: "/developers/api-reference", description: "公开端点逐条说明（数量由契约现算）" },
      { title: "在线 API 浏览", href: "/developers/openapi", description: "Scalar 渲染的 OpenAPI 3.1 文档，可搜索、可看示例" },
      { title: "SDK 与示例", href: "/developers/sdks", description: "Python / PHP / Node 可运行示例" },
    ],
  },
  {
    title: "接入端",
    items: [
      { title: "Windows 桌面（EXE）", href: "/developers/platforms/windows", description: "设备密钥与签名激活" },
      { title: "浏览器扩展", href: "/developers/platforms/browser-extension", description: "OAuth Code + PKCE" },
      { title: "微信小程序", href: "/developers/platforms/mini-program", description: "只调自己的后端" },
      { title: "网站后端", href: "/developers/platforms/web", description: "private_key_jwt 服务端调用" },
    ],
  },
  {
    title: "运维",
    items: [
      { title: "Webhook", href: "/developers/webhooks", description: "事件、签名与重试" },
      { title: "错误码", href: "/developers/errors", description: "按 code 分支，不要按 message" },
      { title: "限流", href: "/developers/rate-limits", description: "分层配额与 429 处理" },
      { title: "Sandbox", href: "/developers/sandbox", description: "测试环境与数据隔离" },
      { title: "变更日志", href: "/developers/changelog", description: "API 版本策略与本次变更" },
      { title: "服务状态", href: "/developers/status", description: "当前可用性与近期成功率" },
    ],
  },
];

/** 拍平的顺序，用于「上一页 / 下一页」。 */
export const DOCS_FLAT: DocsNavItem[] = DOCS_SECTIONS.flatMap((section) => section.items);

export function neighbours(href: string): { prev: DocsNavItem | null; next: DocsNavItem | null } {
  const index = DOCS_FLAT.findIndex((item) => item.href === href);
  if (index < 0) return { prev: null, next: null };
  return {
    prev: index > 0 ? DOCS_FLAT[index - 1] : null,
    next: index < DOCS_FLAT.length - 1 ? DOCS_FLAT[index + 1] : null,
  };
}

/** 机器可读索引，`/developers/llms.txt` 直接用。 */
export const MACHINE_READABLE_FILES = [
  { path: "/developers/llms.txt", description: "llms.txt 索引：阅读顺序与核心约束" },
  { path: "/developers/llms-full.txt", description: "llms-full.txt：完整文档合并为纯文本" },
  { path: "/developers/openapi.yaml", description: "OpenAPI 3.1 规范（YAML）" },
  { path: "/developers/openapi.json", description: "OpenAPI 3.1 规范（JSON）" },
  { path: "/developers/ai-integration-prompt.md", description: "AI 接入提示词：禁止事项与自检清单" },
];
