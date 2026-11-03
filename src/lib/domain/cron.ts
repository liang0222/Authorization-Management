/**
 * 五段 cron 解析（规格 16.11.3「策略按 schedule_cron 执行」）。
 *
 * 只支持标准五段：分 时 日 月 周。字段语法：
 *   `*`      任意
 *   `a`      单值
 *   `a-b`    区间
 *   `a-b/n`  步长
 *   `a/n`    从 a 起按步长（等价 a-max/n）
 *   `a,b,c`  枚举（可与上面组合）
 *
 * 不支持 `L` / `W` / `?` / `#`：这些是 Quartz 扩展，PostgreSQL 与大多数 cron
 * 实现都不认。与其「看起来支持但行为不对」，不如在保存时就拒绝。
 *
 * 时区按 IANA 名计算：policy.timezone 决定「03:00」指的是哪里的 03:00，
 * 这样跨时区租户写的「每天凌晨」符合直觉。
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  /** 0=周日 … 6=周六；表达式里的 7 归一成 0。 */
  dayOfWeek: Set<number>;
  /** 日字段或周字段用了 `*`，用于「两者同时限定时才有意义」的语义判断。 */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const chunk of raw.split(",")) {
    if (chunk === "") return null;
    const [rangePart, stepPart] = chunk.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
      start = Number(a);
      end = Number(b);
    } else {
      if (!/^\d+$/.test(rangePart)) return null;
      start = Number(rangePart);
      // `a/n` 表示从 a 到上界按步长取
      end = stepPart !== undefined ? max : start;
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

/** 解析表达式；不合法返回 null（调用方据此拒绝保存）。 */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dayOfMonth = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dowRaw = parseField(parts[4], 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dowRaw) return null;

  // cron 惯例：7 与 0 都是周日
  const dayOfWeek = new Set<number>();
  for (const value of dowRaw) dayOfWeek.add(value === 7 ? 0 : value);

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** 比 `isCronLike` 更严：真的能解析出触发器才返回 true。 */
export function isExecutableCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

interface ZonedParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

/**
 * 取某个时刻在指定时区下的「墙上时间」各字段。
 * 用 Intl 而不是自己算偏移：夏令时切换日的偏移不固定，自己算必错。
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    });
  } catch {
    // 非法时区名
    return null;
  }
  const parts = formatter.formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    minute: Number(pick("minute")),
    hour: Number(pick("hour")),
    dayOfMonth: Number(pick("day")),
    month: Number(pick("month")),
    dayOfWeek: weekdayMap[pick("weekday")] ?? -1,
  };
}

/**
 * 这个时刻是否命中表达式（精确到分钟）。
 *
 * 日/周同时被限定时按**或**处理（Vixie cron 的语义）：`0 3 1 * 1` 表示
 * 「每月 1 号**或**每周一」的 03:00。很多人误以为是「且」，这里跟随标准实现。
 */
export function matchesCron(fields: CronFields, at: Date, timeZone: string): boolean {
  const parts = zonedParts(at, timeZone);
  if (!parts || parts.dayOfWeek < 0) return false;

  if (!fields.minute.has(parts.minute)) return false;
  if (!fields.hour.has(parts.hour)) return false;
  if (!fields.month.has(parts.month)) return false;

  const domHit = fields.dayOfMonth.has(parts.dayOfMonth);
  const dowHit = fields.dayOfWeek.has(parts.dayOfWeek);

  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/** 便于排错与 UI 展示：把表达式翻成人话。 */
export function describeCron(expression: string, timeZone: string): string {
  const fields = parseCron(expression);
  if (!fields) return `无法解析的调度表达式「${expression}」`;
  const hour = [...fields.hour].sort((a, b) => a - b);
  const minute = [...fields.minute].sort((a, b) => a - b);
  const timeOfDay =
    hour.length === 1 && minute.length === 1
      ? `${String(hour[0]).padStart(2, "0")}:${String(minute[0]).padStart(2, "0")}`
      : "多个时刻";
  const dowNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const when = fields.dowRestricted
    ? [...fields.dayOfWeek].sort((a, b) => a - b).map((d) => dowNames[d]).join("、")
    : fields.domRestricted
      ? `每月 ${[...fields.dayOfMonth].sort((a, b) => a - b).join("、")} 日`
      : "每天";
  return `${when} ${timeOfDay}（${timeZone}）`;
}

/**
 * 从 `from` 起找出下一个命中时刻（最多看 366 天）。
 * 用于 UI 展示「下次执行」，以及调度器漏跑后的补偿判断。
 */
export function nextRunAfter(expression: string, from: Date, timeZone: string): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  // 从下一分钟开始，避免把「当前这一分钟」重复算进去
  const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60_000;
  while (cursor.getTime() < limit) {
    if (matchesCron(fields, cursor, timeZone)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
