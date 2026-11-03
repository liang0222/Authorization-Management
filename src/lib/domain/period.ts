/**
 * 授权周期计算（规格 0.1 / 0.2 / 3.5 / 7.3）。
 *
 * 规则：
 * - `day`：精确 N × 24 小时，不受时区/夏令时影响。
 * - `month`：按授权记录保存的 IANA 时区增加 N 个自然月，保留本地时分秒；
 *   目标月份没有对应日期时钳制到该月最后一天（1 月 31 日 + 3 个月 → 4 月 30 日）。
 * - `lifetime`：expires_at = NULL，不接受普通期限续费。
 */

export type DurationUnit = "day" | "month" | "lifetime";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 在指定 IANA 时区下读取一个瞬时时间的本地日历字段。 */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  const hour = read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // en-CA 在午夜可能输出 24:00:00
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/** 某一瞬时在目标时区相对 UTC 的偏移（毫秒）。 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // formatToParts 精度为秒，用秒级取整避免亚秒误差
  const instant = Math.round(date.getTime() / 1000) * 1000;
  return asUtc - instant;
}

/** 把「目标时区的墙钟时间」转换为 UTC 瞬时（处理夏令时跳变）。 */
export function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const firstOffset = zoneOffsetMs(new Date(guess), timeZone);
  let timestamp = guess - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(timestamp), timeZone);
  if (secondOffset !== firstOffset) {
    timestamp = guess - secondOffset;
  }
  return new Date(timestamp);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 在指定时区按自然月推进；日期越界时钳制到月末。 */
export function addCalendarMonths(start: Date, months: number, timeZone: string): Date {
  const base = getZonedParts(start, timeZone);
  const monthIndex = base.month - 1 + months;
  const year = base.year + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  const day = Math.min(base.day, daysInMonth(year, month));
  return zonedTimeToUtc(
    { ...base, year, month, day },
    timeZone,
  );
}

export interface DurationInput {
  unit: DurationUnit;
  value: number;
}

/**
 * 计算到期时间。
 * @returns lifetime 返回 null；其余返回从 start 起算的 UTC 到期时间。
 */
export function addDuration(
  start: Date,
  duration: DurationInput,
  timeZone: string,
): Date | null {
  if (duration.unit === "lifetime") return null;
  if (!Number.isInteger(duration.value) || duration.value <= 0) {
    throw new Error("duration_value 必须为正整数（lifetime 除外）");
  }
  if (duration.unit === "day") {
    return new Date(start.getTime() + duration.value * DAY_MS);
  }
  return addCalendarMonths(start, duration.value, timeZone);
}

/** 周期的人类可读标签，严格区分自然月与固定天数（禁止把季度写成 90 天）。 */
export function formatDuration(duration: DurationInput): string {
  if (duration.unit === "lifetime") return "永久";
  if (duration.unit === "day") return `${duration.value} 天`;
  if (duration.value === 3) return "一季度（3 个自然月）";
  if (duration.value === 12) return "一年（12 个自然月）";
  if (duration.value === 1) return "1 个自然月";
  return `${duration.value} 个自然月`;
}

export const DURATION_PRESETS: Array<{ id: string; label: string; duration: DurationInput }> = [
  { id: "7d", label: "7 天", duration: { unit: "day", value: 7 } },
  { id: "15d", label: "15 天", duration: { unit: "day", value: 15 } },
  { id: "30d", label: "30 天", duration: { unit: "day", value: 30 } },
  { id: "1q", label: "一季度", duration: { unit: "month", value: 3 } },
  { id: "1y", label: "一年", duration: { unit: "month", value: 12 } },
  { id: "lifetime", label: "永久", duration: { unit: "lifetime", value: 0 } },
];

/** 续费起算点：未到期从原到期时间追加；已过期从服务器当前时间重新起算。 */
export function renewalStart(expiresAt: Date | null, now: Date): Date {
  if (!expiresAt) return now;
  return expiresAt.getTime() > now.getTime() ? expiresAt : now;
}
