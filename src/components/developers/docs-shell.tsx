"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X, ArrowRight, ArrowLeft, ExternalLink } from "lucide-react";
import { DOCS_SECTIONS, DOCS_FLAT, neighbours } from "@/lib/developers/docs-nav";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * 公开文档外壳：顶栏 + 左侧目录 + 正文。
 *
 * 与管理后台的 AppShell 刻意分开——这条路径不需要登录，也不该出现任何后台导航。
 */
export function DocsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { prev, next } = neighbours(pathname);
  /**
   * 在线 OpenAPI 浏览页要占满正文区：Scalar 是「目录 / 正文 / 示例」三栏布局，
   * 塞进 `max-w-3xl`（768px）后示例栏会被挤成一条缝，代码块只能横向滚动。
   * 其余页面仍是阅读型内容，保持 768px 的行宽上限。
   */
  const wide = pathname === "/developers/openapi";

  const nav = (
    <nav className="space-y-6">
      {DOCS_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "关闭目录" : "打开目录"}
            aria-expanded={open}
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </Button>
          <Link href="/developers" className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-[13px] font-semibold text-primary-foreground">
              Z
            </span>
            <span className="text-sm font-semibold">子铭 · 开发者中心</span>
          </Link>
          <span className="ml-1 hidden rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground sm:inline">
            API v1
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <a href="/developers/openapi.yaml" className="gap-1.5">
                OpenAPI
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/dashboard">管理后台</Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-10 px-4 py-8 sm:px-6">
        {wide ? null : (
          <aside className="hidden w-60 shrink-0 lg:block">
            <div className="sticky top-20 max-h-[calc(100svh-6rem)] overflow-y-auto pb-8">{nav}</div>
          </aside>
        )}

        {open ? (
          <div className="fixed inset-0 top-14 z-30 bg-background/95 p-4 lg:hidden">
            <div className="h-full overflow-y-auto pb-16">{nav}</div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1">
          <article className={wide ? "max-w-none" : "max-w-3xl"}>{children}</article>

          <div
            className={cn(
              "mt-12 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between",
              wide ? "max-w-none" : "max-w-3xl",
            )}
          >
            {prev ? (
              <Link
                href={prev.href}
                className="group flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
                <span>
                  <span className="block text-[11px] text-muted-foreground">上一页</span>
                  {prev.title}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={next.href}
                className="group flex items-center gap-2 text-right text-sm text-muted-foreground hover:text-foreground sm:ml-auto"
              >
                <span>
                  <span className="block text-[11px] text-muted-foreground">下一页</span>
                  {next.title}
                </span>
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ) : null}
          </div>
        </main>
      </div>

      <footer className="border-t border-border/70 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>子铭 · 软件授权管理 · 公开开发者文档</span>
          <span className="flex flex-wrap gap-3">
            <a href="/developers/llms.txt" className="hover:text-foreground">
              llms.txt
            </a>
            <a href="/developers/openapi.json" className="hover:text-foreground">
              openapi.json
            </a>
            <Link href="/developers/status" className="hover:text-foreground">
              服务状态
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** 文档页标题区：每个页面统一用它，避免字号/间距漂移。 */
export function DocsHeader({
  title,
  description,
  badge,
}: {
  title: string;
  description?: string;
  badge?: string;
}) {
  return (
    <div className="mb-8">
      {badge ? (
        <span className="mb-3 inline-block rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
          {badge}
        </span>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      {description ? (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

export { DOCS_FLAT };
