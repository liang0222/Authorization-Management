"use client";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/** 表单项包装：Label 必填标记 + 辅助说明 + 字段级错误（规格 15.7）。 */
export function FormField({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
  className,
  actions,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
          {label}
          {required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </Label>
        {actions}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}

export function FormHint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}
