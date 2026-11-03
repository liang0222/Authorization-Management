"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { ClientApiError } from "@/lib/client/api";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/app/feedback";

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** 排序字段名；提供后表头可点击排序 */
  sortKey?: string;
  align?: "left" | "right" | "center";
  className?: string;
  headerClassName?: string;
  width?: string;
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: ClientApiError | Error | null;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  sort?: { key: string; order: "asc" | "desc" } | null;
  onSortChange?: (key: string, order: "asc" | "desc") => void;
  footer?: ReactNode;
  dense?: boolean;
  caption?: string;
}

/**
 * 统一数据表格（规格 15.6）。
 * 分页/筛选/排序由调用方使用服务端数据实现；本组件只负责一致的呈现与状态。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  empty,
  onRowClick,
  selectable = false,
  selected,
  onSelectedChange,
  sort,
  onSortChange,
  footer,
  dense = false,
  caption,
}: DataTableProps<T>) {
  if (error) {
    return <ErrorState error={error} onRetry={onRetry} className="m-4" />;
  }
  if (loading && (!rows || rows.length === 0)) {
    return <TableSkeleton rows={6} columns={Math.min(columns.length, 7)} />;
  }
  if (!rows || rows.length === 0) {
    return <div className="p-4">{empty ?? <EmptyState title="暂无数据" description="调整筛选条件或创建第一条记录。" />}</div>;
  }

  const allSelected = selectable && selected ? rows.every((row) => selected.has(rowKey(row))) : false;
  const someSelected = selectable && selected ? rows.some((row) => selected.has(rowKey(row))) : false;

  const toggleAll = () => {
    if (!onSelectedChange) return;
    const next = new Set(selected ?? []);
    if (allSelected) {
      rows.forEach((row) => next.delete(rowKey(row)));
    } else {
      rows.forEach((row) => next.add(rowKey(row)));
    }
    onSelectedChange(next);
  };

  const toggleRow = (key: string) => {
    if (!onSelectedChange) return;
    const next = new Set(selected ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange(next);
  };

  const handleSort = (column: DataColumn<T>) => {
    if (!column.sortKey || !onSortChange) return;
    const nextOrder = sort?.key === column.sortKey && sort.order === "desc" ? "asc" : "desc";
    onSortChange(column.sortKey, nextOrder);
  };

  return (
    <div className="relative w-full overflow-x-auto">
      <Table>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            {selectable ? (
              <TableHead className="w-10 pl-3">
                <Checkbox
                  aria-label="全选当前页"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => {
              const isSorted = sort?.key === column.sortKey;
              const alignClass =
                column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left";
              return (
                <TableHead
                  key={column.key}
                  style={column.width ? { width: column.width } : undefined}
                  className={cn("h-9 whitespace-nowrap text-xs font-medium text-muted-foreground", alignClass, column.headerClassName)}
                >
                  {column.sortKey && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => handleSort(column)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-0.5 transition-colors hover:text-foreground",
                        isSorted && "text-foreground",
                      )}
                      aria-label={`按 ${typeof column.header === "string" ? column.header : column.key} 排序`}
                    >
                      {column.header}
                      {isSorted ? (
                        sort?.order === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const key = rowKey(row);
            const isSelected = selected?.has(key) ?? false;
            return (
              <TableRow
                key={key}
                data-state={isSelected ? "selected" : undefined}
                className={cn(
                  onRowClick && "cursor-pointer",
                  isSelected && "bg-primary/[0.04]",
                )}
                onClick={() => onRowClick?.(row)}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={(event) => {
                  if (onRowClick && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onRowClick(row);
                  }
                }}
              >
                {selectable ? (
                  <TableCell className="pl-3" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`选择第 ${index + 1} 行`}
                      checked={isSelected}
                      onCheckedChange={() => toggleRow(key)}
                    />
                  </TableCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    style={column.width ? { width: column.width } : undefined}
                    className={cn(
                      dense ? "py-2" : "py-2.5",
                      column.align === "right" && "text-right",
                      column.align === "center" && "text-center",
                      column.className,
                    )}
                  >
                    {column.cell(row, index)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {loading ? (
        <div className="pointer-events-none absolute inset-x-0 top-9 h-px bg-primary/60" aria-hidden />
      ) : null}
      {footer ? <div className="border-t border-border">{footer}</div> : null}
    </div>
  );
}
