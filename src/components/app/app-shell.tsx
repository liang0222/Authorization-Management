"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Sidebar, useSidebarCollapsed } from "@/components/app/sidebar";
import { Topbar } from "@/components/app/topbar";
import { useSession } from "@/lib/client/session-context";
import { cn } from "@/lib/utils";

/**
 * 后台全局 Shell（规格 15.4）：
 * Sidebar + Topbar + Content Area；桌面端可折叠，窄屏用抽屉导航。
 * 未登录时跳转登录页并保留 next 参数。
 */
export function AppShell({
  children,
  environment,
}: {
  children: React.ReactNode;
  /** 部署环境（production / sandbox / development）：非生产在顶栏挂一条常驻提示。 */
  environment?: string;
}) {
  const { status, session } = useSession();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  // 必须稳定引用：RouteBridge 的 effect 依赖它，每次渲染新建函数会把抽屉「开了又立刻关掉」
  const closeMobileNav = useCallback(() => setMobileOpen(false), []);

  const ready = status === "ready" && session !== null;

  return (
    <>
      {/* 路由守卫与「切换路由时收起抽屉」都依赖 usePathname：动态路由（/app/licenses/[id]）
          的参数在构建期不可知，该 hook 会挂起，因此必须各自包一层 Suspense。
          注意边界只包这两块而不是整个 Shell——否则页面内容会一起被丢出预渲染校验。
          RouteBridge 必须渲染在 ready 判断之外：未登录时 Shell 只剩骨架，
          守卫若在骨架里就永远不会触发跳转。 */}
      <Suspense fallback={null}>
        <RouteBridge onNavigate={closeMobileNav} />
      </Suspense>

      {ready ? (
        <div className="flex min-h-screen bg-background">
          <div className="sticky top-0 hidden h-screen shrink-0 lg:block">
            <Suspense
              fallback={
                <div
                  className={cn(
                    "h-full border-r border-sidebar-border bg-sidebar",
                    collapsed ? "w-16" : "w-60",
                  )}
                />
              }
            >
              <Sidebar
                collapsed={collapsed}
                onToggle={() => setCollapsed(!collapsed)}
                className={cn(
                  "transition-[width] duration-200",
                  collapsed ? "w-16" : "w-60",
                )}
              />
            </Suspense>
          </div>

          <Drawer
            open={mobileOpen}
            onOpenChange={setMobileOpen}
            direction="left"
          >
            <DrawerContent className="w-[280px] p-0">
              <DrawerTitle className="sr-only">主导航</DrawerTitle>
              <Suspense fallback={<div className="h-full w-full" />}>
                <Sidebar
                  collapsed={false}
                  variant="mobile"
                  onNavigate={closeMobileNav}
                  className="h-full w-full"
                />
              </Suspense>
            </DrawerContent>
          </Drawer>

          <div className="flex min-w-0 flex-1 flex-col">
            {environment && environment !== "production" ? (
              <div
                className={cn(
                  "flex items-center justify-center gap-2 border-b px-4 py-1 text-[12px] font-medium",
                  environment === "sandbox"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "border-border bg-muted/40 text-muted-foreground",
                )}
                role="status"
              >
                <span className="size-1.5 rounded-full bg-current" aria-hidden />
                {environment === "sandbox"
                  ? "Sandbox 环境 · 数据与生产完全隔离，可随意测试"
                  : "开发环境 · 此处签发的授权仅供联调"}
              </div>
            ) : null}
            {/* 跳过导航链接：键盘用户按一次 Tab 就能越过 16 个导航项直达正文，
                平时不可见，获得焦点后浮到左上角。 */}
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-sm"
            >
              跳到主要内容
            </a>
            <Topbar onOpenNav={() => setMobileOpen(true)} />
            <main
              id="main-content"
              className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-4 sm:px-5 sm:py-5 lg:px-6"
            >
              {children}
            </main>
            <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
              子铭 · 授权中心 v1.2 · 所有状态变更均写入审计日志
            </footer>
          </div>
        </div>
      ) : (
        <AppShellSkeleton />
      )}
    </>
  );
}

/**
 * 路由桥：只负责两件与 URL 相关的事——未登录跳转登录页（保留 next 参数）、
 * 路由变化时收起移动端抽屉。它不渲染任何可见内容。
 */
function RouteBridge({ onNavigate }: { onNavigate: () => void }) {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unauthenticated") {
      const next = encodeURIComponent(pathname ?? "/app/dashboard");
      router.replace(`/login?next=${next}`);
    }
  }, [status, router, pathname]);

  useEffect(() => {
    onNavigate();
  }, [pathname, onNavigate]);

  return null;
}

/**
 * Shell 骨架：会话校验期间显示，避免白屏。
 */
export function AppShellSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden />
        <p className="text-sm">正在校验会话…</p>
      </div>
    </div>
  );
}
