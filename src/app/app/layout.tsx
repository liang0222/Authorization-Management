import { AppShell } from "@/components/app/app-shell";
import { config } from "@/lib/config";

/**
 * 后台布局：Sidebar + Topbar + 内容区。
 *
 * URL 相关的 hook（usePathname）已经收进 AppShell 内部的 Suspense 边界里，
 * 所以这里不需要再包一层——页面内容保持在边界之外，仍参与预渲染校验。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell environment={config.deploymentEnv}>{children}</AppShell>;
}
