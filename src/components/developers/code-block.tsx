"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * 文档里的代码块。
 * 复制按钮是这个页面唯一的交互，所以单独做成客户端组件，让正文保持服务端渲染。
 */
export function CodeBlock({
  code,
  language,
  filename,
  className,
}: {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 非安全上下文/无权限时静默失败：用户仍可手动选中复制。
    }
  }

  return (
    <figure className={cn("group relative overflow-hidden rounded-lg border border-border bg-muted/40", className)}>
      {(filename || language) && (
        <figcaption className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">{filename ?? language}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void copy()}
            aria-label={copied ? "已复制" : "复制代码"}
          >
            {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
          </Button>
        </figcaption>
      )}
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </figure>
  );
}
