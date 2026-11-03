"use client";

import { AlertTriangle, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/app/copy-button";
import { cn } from "@/lib/utils";

export interface SecretItem {
  label: string;
  value: string;
  hint?: string;
}

/**
 * 一次性密钥展示（授权码 / 客户端 Secret / Webhook Secret）。
 * 规则：只在创建/轮换成功后的响应里出现一次；服务端只保存哈希。
 */
export function SecretReveal({
  title,
  description,
  secrets,
  warning,
  download,
  onDismiss,
  className,
}: {
  title: string;
  description?: string;
  secrets: SecretItem[];
  warning?: string;
  download?: { filename: string; content: string };
  onDismiss?: () => void;
  className?: string;
}) {
  const downloadFile = () => {
    if (!download) return;
    const blob = new Blob(["\ufeff" + download.content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = download.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={cn("space-y-3 rounded-xl border border-warning/40 bg-warning/[0.07] p-4", className)}
      role="region"
      aria-label={title}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {onDismiss ? (
          <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="关闭密钥展示">
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="space-y-2">
        {secrets.map((secret) => (
          <div key={secret.label} className="rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
              <span className="text-xs text-muted-foreground">{secret.label}</span>
              <CopyButton value={secret.value} label={`复制${secret.label}`} />
            </div>
            <div className="flex items-center gap-2 px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-foreground">
                {secret.value}
              </code>
            </div>
            {secret.hint ? <p className="px-3 pb-2 text-xs text-muted-foreground">{secret.hint}</p> : null}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-warning-foreground/90">{warning ?? "关闭或刷新页面后将无法再次查看，请立即妥善保存。"}</p>
        {download ? (
          <Button size="sm" variant="outline" onClick={downloadFile}>
            <Download className="size-3.5" /> 下载 CSV（仅本次）
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** 批量授权码导出：仅在前端内存中生成 CSV，不落库。 */
export function licensesToCsv(rows: Array<{ licenseKey: string; id: string; expiresAt: string | null }>): string {
  const header = "license_key,license_id,expires_at";
  const lines = rows.map((row) => `${row.licenseKey},${row.id},${row.expiresAt ?? ""}`);
  return [header, ...lines].join("\n");
}
