"use client";

import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "@/lib/client/session-context";

/**
 * 全局 Provider：
 * - SessionProvider：会话 / 权限 / 导航（隐藏导航不是权限控制，后端仍逐请求校验）
 * - TooltipProvider：折叠侧栏、图标按钮必须有 Tooltip
 * - Toaster：短暂成功/失败反馈（关键错误同时留在页面内）
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <TooltipProvider delayDuration={200}>
        <SessionProvider>
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </SessionProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
