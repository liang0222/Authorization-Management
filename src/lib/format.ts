/** 统一格式化工具：避免各页面各写一套时间/数字格式。 */

const DEFAULT_LOCALE = "zh-CN";

export function formatDateTime(
  value: string | Date | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDate(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 相对时间：3 分钟前 / 2 天后。用于“最后在线”“最近操作”等。 */
export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(DEFAULT_LOCALE, { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) {
      return formatter.format(Math.round(diff / ms), unit);
    }
  }
  return "刚刚";
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(DEFAULT_LOCALE);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** 周期文案：季度/一年必须显示为自然月，不能退化成 90/365 天。 */
export function durationLabel(duration: { unit: string; value: number } | null | undefined): string {
  if (!duration) return "—";
  if (duration.unit === "lifetime") return "永久";
  if (duration.unit === "day") return `${duration.value} 天`;
  if (duration.unit === "month") {
    if (duration.value === 3) return "一季度（3 个自然月）";
    if (duration.value === 12) return "一年（12 个自然月）";
    return `${duration.value} 个自然月`;
  }
  return `${duration.value} ${duration.unit}`;
}

export function humanBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 敏感值脱敏：保留首尾，中间用 • 代替。 */
export function maskSecret(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail) return "•".repeat(value.length);
  return `${value.slice(0, head)}${"•".repeat(Math.min(16, value.length - head - tail))}${value.slice(-tail)}`;
}
