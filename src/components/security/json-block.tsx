"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * 只读 JSON 代码块（审计快照 / 验证日志详情）。
 * 统一等宽字体 + overflow-auto，长内容只在块内滚动，不撑破页面。
 */
export function JsonBlock({
  value,
  label,
  emptyLabel = "无快照",
  className,
}: {
  value: unknown;
  label?: string;
  emptyLabel?: string;
  className?: string;
}) {
  const text = useMemo(() => {
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}
      {text ? (
        <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground">
          {text}
        </pre>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      )}
    </div>
  );
}
