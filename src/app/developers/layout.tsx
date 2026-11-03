import type { Metadata } from "next";
import { DocsShell } from "@/components/developers/docs-shell";

/**
 * 公开开发者文档的布局。
 *
 * 规格 27.20 第一条：`/developers` 必须免登录可读，且页面里不能出现真实凭证。
 * 因此这里既没有鉴权，也没有任何后台数据请求——所有内容都是静态说明 + 公开文件链接。
 */
export const metadata: Metadata = {
  title: {
    default: "开发者文档 · 子铭",
    template: "%s · 子铭开发者文档",
  },
  description: "子铭软件授权 API v1 的公开接入文档：激活、心跳、权限、Webhook 与错误处理。",
  robots: { index: true, follow: true },
};

export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
