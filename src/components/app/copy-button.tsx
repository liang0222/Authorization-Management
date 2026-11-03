"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** 图标复制按钮：必须有 Tooltip 与可访问名称（规格 15.5）。 */
export function CopyButton({
  value,
  label = "复制",
  tooltip = "复制到剪贴板",
  variant = "ghost",
  size = "icon-sm",
  className,
  disabled,
}: {
  value: string;
  label?: string;
  tooltip?: string;
  variant?: "ghost" | "outline" | "secondary" | "default";
  size?: "icon-xs" | "icon-sm" | "icon" | "sm" | "xs";
  className?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("浏览器拒绝了剪贴板访问，请手动选择文本复制");
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          onClick={copy}
          disabled={disabled}
          aria-label={label}
          className={className}
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "已复制" : tooltip}</TooltipContent>
    </Tooltip>
  );
}
