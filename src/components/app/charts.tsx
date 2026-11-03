"use client";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Tone } from "@/components/app/status-badge";

const TONE_VAR: Record<Tone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
  info: "var(--info)",
  neutral: "var(--muted-foreground)",
  brand: "var(--primary)",
};

/**
 * 轻量柱状图：用 HTML 弹性盒子而不是 SVG，这样柱子始终撑满容器宽度，
 * 不会因为 viewBox 固定比例在宽卡片里被「居中缩小」留出大片空白。
 * `value` 是总量，`secondary` 是其中的失败量（叠在顶部显示）。
 * 每根柱子都有 Tooltip 给出精确数值，颜色不是唯一信息载体。
 */
export function BarChart({
  data,
  height = 140,
  tone = "brand",
  valueLabel = "数量",
  className,
}: {
  data: Array<{ label: string; value: number; secondary?: number }>;
  height?: number;
  tone?: Tone;
  valueLabel?: string;
  className?: string;
}) {
  const max = Math.max(1, ...data.map((item) => item.value));
  const summary = data.map((item) => `${item.label}: ${item.value}`).join("，");

  return (
    <figure className={cn("flex flex-col gap-1.5", className)}>
      <div
        className="relative flex flex-1 items-end gap-[3px] sm:gap-1.5"
        style={{ minHeight: height }}
        role="img"
        aria-label={`${valueLabel}趋势图，${summary}`}
      >
        {/* 网格线：纯装饰，四等分便于估读 */}
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <div
            key={ratio}
            aria-hidden
            className="absolute inset-x-0 border-t border-dashed border-border/70"
            style={{ bottom: `${ratio * 100}%` }}
          />
        ))}
        {data.map((item, index) => {
          const totalHeight = Math.max(1.5, (item.value / max) * 100);
          const failed = Math.min(item.value, Math.max(0, item.secondary ?? 0));
          const failedShare = item.value > 0 ? (failed / item.value) * 100 : 0;
          return (
            <Tooltip key={`${item.label}-${index}`}>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  className="group relative flex h-full flex-1 cursor-default items-end outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div
                    className="relative w-full rounded-t-[3px] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 sm:opacity-90"
                    style={{
                      height: `${totalHeight}%`,
                      background: TONE_VAR[tone],
                      minHeight: 2,
                    }}
                  >
                    {failed > 0 ? (
                      <div
                        className="absolute inset-x-0 top-0 rounded-t-[3px] bg-destructive"
                        style={{ height: `${failedShare}%`, minHeight: 2 }}
                      />
                    ) : null}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <div className="font-medium">{item.label}</div>
                <div className="tabular text-muted-foreground">
                  {valueLabel} {item.value}
                  {item.secondary !== undefined ? ` · 失败 ${item.secondary}` : ""}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex gap-[3px] sm:gap-1.5" aria-hidden>
        {data.map((item, index) => (
          <div
            key={`${item.label}-axis-${index}`}
            className="tabular flex-1 truncate text-center text-[9px] text-muted-foreground"
          >
            {item.label.slice(5)}
          </div>
        ))}
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

/** 状态分布：横向条 + 文案 + 数字（颜色不是唯一信息载体）。 */
export function StatusBars({
  items,
  total,
}: {
  items: Array<{ label: string; value: number; tone: Tone }>;
  total: number;
}) {
  const safeTotal = Math.max(1, total);
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-foreground">{item.label}</span>
            <span className="tabular text-muted-foreground">
              {item.value}
              <span className="ml-1 text-[11px]">({Math.round((item.value / safeTotal) * 100)}%)</span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{ width: `${Math.min(100, (item.value / safeTotal) * 100)}%`, background: TONE_VAR[item.tone] }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 迷你趋势线（KPI 卡片内）。 */
export function Sparkline({ values, tone = "brand" }: { values: number[]; tone?: Tone }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = 28 - ((value - min) / range) * 24;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" className="h-7 w-full" aria-hidden preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={TONE_VAR[tone]} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
