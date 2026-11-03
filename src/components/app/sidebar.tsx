"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Building2,
  ChartNoAxesColumn,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  ListChecks,
  Package,
  ReceiptText,
  Users,
  Waypoints,
  ShieldCheck,
  KeyRound,
  Webhook,
  Plug,
  FileKey,
  ScrollText,
  UserCog,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSession, type NavItem } from "@/lib/client/session-context";

const ICON_BY_HREF: Record<string, React.ElementType> = {
  "/app/dashboard": LayoutDashboard,
  "/app/products": Package,
  "/app/customers": Users,
  "/app/plans": ReceiptText,
  "/app/features": ListChecks,
  "/app/licenses": FileKey,
  "/app/devices": Waypoints,
  "/app/developer/api": Plug,
  "/app/developer/credentials": KeyRound,
  "/app/developer/webhooks": Webhook,
  "/app/developer/usage": ChartNoAxesColumn,
  "/app/security/signing-keys": ShieldCheck,
  "/app/security/verification-logs": ScrollText,
  "/app/security/audit-logs": UserCog,
  "/app/settings/members": Users,
  "/app/settings/organization": Building2,
  "/app/settings/system": Settings2,
};

export function isItemActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  if (item.matchPrefixes?.some((prefix) => pathname.startsWith(prefix))) return true;
  return false;
}

const STORAGE_KEY = "ziming.sidebar.collapsed";

/** 主导航（Sidebar）：折叠时图标必须有 Tooltip，当前路由有明确 Active State。 */
export function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
  className,
  variant = "desktop",
}: {
  collapsed: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  className?: string;
  variant?: "desktop" | "mobile";
}) {
  const pathname = usePathname();
  const { session } = useSession();
  const navGroups = session?.navGroups ?? [];

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        className,
      )}
      aria-label="主导航"
    >
      <div className={cn("flex h-14 items-center border-b border-sidebar-border px-3", collapsed && variant === "desktop" ? "justify-center" : "justify-between")}>
        <Link
          href="/app/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-1 py-1 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-[13px] font-bold text-sidebar-primary-foreground">
            Z
          </span>
          {collapsed && variant === "desktop" ? null : (
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight">子铭</span>
              <span className="text-[11px] text-muted-foreground">软件授权管理</span>
            </span>
          )}
        </Link>
        {variant === "mobile" ? (
          <Button variant="ghost" size="icon-sm" onClick={onNavigate} aria-label="关闭导航">
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {navGroups.map((group) => (
          <div key={group.title} className="space-y-1">
            {!collapsed || variant === "mobile" ? (
              <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.title}
              </p>
            ) : (
              <div className="mx-auto mb-1 h-px w-6 bg-sidebar-border" aria-hidden />
            )}
            {group.items.map((item) => {
              const active = isItemActive(pathname ?? "", item);
              const Icon = ICON_BY_HREF[item.href] ?? LayoutDashboard;
              const link = (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150",
                    "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-xs"
                      : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                    collapsed && variant === "desktop" && "justify-center px-0",
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", active ? "text-sidebar-primary" : "text-muted-foreground group-hover:text-sidebar-foreground")} aria-hidden />
                  {collapsed && variant === "desktop" ? null : <span className="truncate">{item.label}</span>}
                  {active && !(collapsed && variant === "desktop") ? (
                    <span className="ml-auto size-1.5 rounded-full bg-sidebar-primary" aria-hidden />
                  ) : null}
                </Link>
              );

              if (collapsed && variant === "desktop") {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                );
              }
              return link;
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-2">
        {collapsed && variant === "desktop" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="展开侧栏" className="mx-auto flex">
                <ChevronsRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">展开侧栏</TooltipContent>
          </Tooltip>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 px-1">
              <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-xs text-muted-foreground">{session?.organization.name ?? "当前组织"}</span>
            </div>
            {variant === "desktop" ? (
              <Button variant="ghost" size="icon-xs" onClick={onToggle} aria-label="折叠侧栏">
                <ChevronsLeft className="size-3.5" />
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

/** 折叠状态持久化（刷新后保持用户选择）。 */
export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "1") setCollapsed(true);
  }, []);
  const update = (next: boolean) => {
    setCollapsed(next);
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  };
  return [collapsed, update];
}
