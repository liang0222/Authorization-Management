"use client";

import { useEffect, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/client/use-resource";

export interface FilterChip {
  label: string;
  value: string;
  onRemove: () => void;
}

/**
 * 筛选栏（规格 15.6）：
 * - 输入防抖 300ms，但按 Enter 立即搜索；
 * - 明确展示当前筛选条件，可一键清空；
 * - 右侧放刷新/导出等次要操作。
 */
export function FilterBar({
  searchValue,
  onSearchChange,
  onSearchSubmit,
  searchPlaceholder = "搜索…",
  filters,
  chips,
  onReset,
  actions,
  className,
}: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit?: () => void;
  searchPlaceholder?: string;
  filters?: React.ReactNode;
  chips?: FilterChip[];
  onReset?: () => void;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2.5 border-b border-border px-3 py-3", className)}>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSearchSubmit?.();
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 pl-8 text-sm"
            />
            {searchValue ? (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => onSearchChange("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {filters}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {chips && chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">当前筛选</span>
          {chips.map((chip) => (
            <span
              key={`${chip.label}-${chip.value}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 py-0.5 pr-1 pl-2 text-xs text-foreground"
            >
              <span className="text-muted-foreground">{chip.label}：</span>
              {chip.value}
              <button
                type="button"
                onClick={chip.onRemove}
                aria-label={`移除筛选 ${chip.label}`}
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {onReset ? (
            <Button variant="ghost" size="xs" onClick={onReset} className="text-muted-foreground">
              清空全部
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 搜索输入与 URL 同步时的本地状态（防抖 + 回车立即生效）。 */
export function useSearchState(
  initial: string,
  apply: (value: string) => void,
  delay = 300,
): { value: string; setValue: (next: string) => void; submit: () => void } {
  const [value, setValue] = useState(initial);
  const debounced = useDebouncedValue(value, delay);

  useEffect(() => {
    if (debounced !== initial) apply(debounced);
    // 只在防抖值变化时触发，避免初始渲染重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return { value, setValue, submit: () => apply(value) };
}

/** 批量操作条：明确显示选中数量与影响范围（规格 15.6）。 */
export function SelectionBar({
  count,
  scopeHint,
  onClear,
  children,
}: {
  count: number;
  scopeHint?: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/20 bg-primary/[0.04] px-3 py-2 text-sm">
      <p className="text-foreground">
        已选择 <span className="tabular font-semibold">{count}</span> 项
        {scopeHint ? <span className="ml-2 text-xs text-muted-foreground">{scopeHint}</span> : null}
      </p>
      <div className="flex items-center gap-2">
        {children}
        <Button size="xs" variant="ghost" onClick={onClear}>
          取消选择
        </Button>
      </div>
    </div>
  );
}
