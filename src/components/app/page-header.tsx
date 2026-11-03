"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: string;
  href?: string;
}

/** 页面头部：标题、说明、面包屑与主要操作（每个操作区原则上只有一个主按钮）。 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  meta,
  className,
}: {
  title: string;
  description?: string;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="面包屑" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
              {index > 0 ? <ChevronRight className="size-3" aria-hidden /> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="rounded transition-colors hover:text-foreground focus-visible:text-foreground">
                  {crumb.label}
                </Link>
              ) : (
                <span className={index === breadcrumbs.length - 1 ? "text-foreground" : undefined}>{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description ? <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
          {meta ? <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
      </div>
    </header>
  );
}

/** 内容分区：统一卡片外观（标题 + 说明 + 操作 + 内容）。 */
export function Section({
  id,
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: {
  /** 锚点 id：用于顶栏跳转到页面内的具体分区（如 /app/settings/profile#security）。 */
  id?: string;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section id={id} className={cn("scroll-mt-20 rounded-xl border border-border bg-card shadow-xs", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </section>
  );
}

export interface InfoItem {
  label: string;
  value: React.ReactNode;
  hint?: string;
  mono?: boolean;
}

/** 信息栅格：详情页概览区统一排版。 */
export function InfoGrid({ items, columns = 3 }: { items: InfoItem[]; columns?: 2 | 3 | 4 }) {
  const gridClass =
    columns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : columns === 4
        ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
        : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3";
  return (
    <dl className={cn("grid gap-x-6 gap-y-4", gridClass)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn("truncate text-sm text-foreground", item.mono && "font-mono text-[13px]")}>
            {item.value || <span className="text-muted-foreground">—</span>}
          </dd>
          {item.hint ? <p className="text-xs text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}
