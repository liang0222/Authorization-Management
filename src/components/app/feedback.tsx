"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ClientApiError } from "@/lib/client/api";

/** 空状态：必须给出下一步动作，不能只显示一片空白。 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 py-14 text-center",
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon ?? <Inbox className="size-5" aria-hidden />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** 错误状态：保留具体错误码与请求 ID，便于排障。 */
export function ErrorState({
  error,
  onRetry,
  className,
  compact = false,
}: {
  error: ClientApiError | Error | null;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const isNetwork = "code" in (error ?? {}) && (error as ClientApiError).code === "NETWORK_ERROR";
  const code = error && "code" in error ? (error as ClientApiError).code : null;
  const requestId = error && "requestId" in error ? (error as ClientApiError).requestId : null;

  if (compact) {
    return (
      <div className={cn("flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm", className)}>
        <span className="text-destructive">{error?.message ?? "加载失败"}</span>
        {onRetry ? (
          <Button size="xs" variant="ghost" onClick={onRetry}>
            <RefreshCw className="size-3" /> 重试
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        {isNetwork ? <WifiOff className="size-5" aria-hidden /> : <AlertTriangle className="size-5" aria-hidden />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">加载失败</p>
        <p className="max-w-md text-sm text-muted-foreground">{error?.message ?? "发生未知错误"}</p>
        {code ? (
          <p className="text-xs text-muted-foreground">
            错误码 <span className="font-mono">{code}</span>
            {requestId ? (
              <>
                {" · "}请求 ID <span className="font-mono">{requestId}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> 重新加载
        </Button>
      ) : null}
    </div>
  );
}

/** 表格骨架屏：行数与列数可配置，保持与真实表格一致的密度。 */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2 p-2" aria-busy="true" aria-label="数据加载中">
      <div className="flex gap-3 px-2">
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={index} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-3 rounded-md px-2 py-2.5">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn("h-4", columnIndex === 0 ? "w-40" : "flex-1")}
              style={{ opacity: 1 - rowIndex * 0.08 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 页面级骨架：详情页首屏使用。 */
export function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
