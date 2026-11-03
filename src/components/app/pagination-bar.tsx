"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 分页条：页码基于服务端返回的 pageCount，不臆造数据。 */
export function PaginationBar({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  disabled = false,
  unit = "条",
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  disabled?: boolean;
  unit?: string;
}) {
  const pages = buildPageList(page, pageCount);
  return (
    <div className="flex flex-col gap-3 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        共 <span className="tabular font-medium text-foreground">{total}</span> {unit} · 第{" "}
        <span className="tabular font-medium text-foreground">{page}</span> / {pageCount} 页
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange ? (
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
            disabled={disabled}
          >
            <SelectTrigger size="sm" className="h-7 w-[104px] text-xs" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  每页 {size} 条
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="上一页"
            disabled={disabled || page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          {pages.map((item, index) =>
            item === "…" ? (
              <span key={`gap-${index}`} className="px-1 text-xs text-muted-foreground" aria-hidden>
                …
              </span>
            ) : (
              <Button
                key={item}
                size="sm"
                variant={item === page ? "default" : "ghost"}
                className="min-w-7 tabular px-2"
                aria-current={item === page ? "page" : undefined}
                disabled={disabled}
                onClick={() => onPageChange(item)}
              >
                {item}
              </Button>
            ),
          )}
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="下一页"
            disabled={disabled || page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function buildPageList(page: number, pageCount: number): Array<number | "…"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const result: Array<number | "…"> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  if (start > 2) result.push("…");
  for (let index = start; index <= end; index += 1) result.push(index);
  if (end < pageCount - 1) result.push("…");
  result.push(pageCount);
  return result;
}
