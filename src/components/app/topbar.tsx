"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  BookOpen,
  ChevronDown,
  Keyboard,
  LogOut,
  Menu,
  Moon,
  Search,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSession } from "@/lib/client/session-context";
import { useResource } from "@/lib/client/use-resource";
import { CommandMenu } from "@/components/app/command-menu";

/** 顶栏：组织上下文、全局搜索（⌘K）、通知、帮助、主题、用户菜单。 */
export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  const { session, logout } = useSession();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [commandOpen, setCommandOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 通知用真实数据：30 天内到期的授权数量
  const expiring = useResource<{ total: number }>(
    session ? "/api/v1/admin/licenses?expiringInDays=30&pageSize=1&page=1" : null,
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      toast.error("退出登录失败，请重试");
      setLoggingOut(false);
    }
  };

  const initials = (session?.user.displayName ?? "U").slice(0, 1);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
      <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onOpenNav} aria-label="打开导航">
        <Menu className="size-4" />
      </Button>

      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <span className="truncate text-sm font-medium text-foreground">{session?.organization.name ?? "—"}</span>
        <Badge variant="outline" className="status-brand h-5 border-primary/25 bg-primary/5 text-[11px]">
          {session?.role.name ?? "—"}
        </Badge>
        {session ? (
          <span className="text-[11px] text-muted-foreground">{session.organization.timezone}</span>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setCommandOpen(true)}
        className="ml-auto flex h-8 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:ml-4 md:w-64"
        aria-label="打开全局搜索"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="hidden md:inline">搜索页面、操作…</span>
        <span className="ml-auto hidden items-center gap-0.5 rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] md:flex">
          <Keyboard className="size-2.5" aria-hidden />K
        </span>
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild aria-label="通知">
              <Link href="/app/licenses?expiringInDays=30">
                <span className="relative">
                  <Bell className="size-4" />
                  {expiring.data && expiring.data.total > 0 ? (
                    <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-warning text-[9px] font-bold text-warning-foreground">
                      {expiring.data.total > 9 ? "9+" : expiring.data.total}
                    </span>
                  ) : null}
                </span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {expiring.data ? `${expiring.data.total} 份授权将在 30 天内到期` : "通知"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild aria-label="API 接入文档">
              <Link href="/app/developer/api">
                <BookOpen className="size-4" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>接入文档</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>切换主题</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ml-1 h-8 gap-1.5 px-1.5"
              aria-label={`账户菜单：${session?.user.displayName ?? ""}`}
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {initials}
              </span>
              <span className="hidden max-w-24 truncate text-xs sm:inline">{session?.user.displayName}</span>
              <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{session?.user.displayName}</span>
              <span className="text-xs font-normal text-muted-foreground">{session?.user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/app/settings/profile">
                <UserRound className="size-3.5" /> 个人资料
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/app/settings/profile#security">
                <ShieldCheck className="size-3.5" /> 安全设置
              </Link>
            </DropdownMenuItem>
            {session?.permissions.includes("org:read") ? (
              <DropdownMenuItem asChild>
                <Link href="/app/settings/organization">
                  <ShieldCheck className="size-3.5" /> 组织设置
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={loggingOut}
              onSelect={(event) => {
                event.preventDefault();
                void handleLogout();
              }}
            >
              <LogOut className="size-3.5" /> {loggingOut ? "正在退出…" : "退出登录"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} onNavigate={(href) => router.push(href)} />
    </header>
  );
}
