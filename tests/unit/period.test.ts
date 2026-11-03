import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  addDuration,
  daysInMonth,
  formatDuration,
  getZonedParts,
  renewalStart,
  zonedTimeToUtc,
} from "@/lib/domain/period";

const SH = "Asia/Shanghai";
const NY = "America/New_York";

describe("addDuration：固定天数按精确 24 小时", () => {
  it("7 / 15 / 30 天分别精确增加对应小时数", () => {
    const start = new Date("2026-03-01T00:00:00Z");
    expect(addDuration(start, { unit: "day", value: 7 }, SH)?.toISOString()).toBe("2026-03-08T00:00:00.000Z");
    expect(addDuration(start, { unit: "day", value: 15 }, SH)?.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    expect(addDuration(start, { unit: "day", value: 30 }, SH)?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });

  it("跨夏令时的“天”仍然是 24 小时（与自然日不同）", () => {
    // 纽约 2026-03-08 进入夏令时，本地 02:00 不存在
    const start = new Date("2026-03-07T07:00:00Z"); // 纽约 03-07 02:00 EST
    const next = addDuration(start, { unit: "day", value: 1 }, NY);
    expect(next).not.toBeNull();
    expect(next!.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });
});

describe("addDuration：自然月与月末钳制", () => {
  it("1 月 31 日 + 3 个自然月 → 4 月 30 日（保留时分秒）", () => {
    const start = zonedTimeToUtc(
      { year: 2026, month: 1, day: 31, hour: 10, minute: 30, second: 0 },
      SH,
    );
    const result = addDuration(start, { unit: "month", value: 3 }, SH);
    const parts = getZonedParts(result!, SH);
    expect(parts).toMatchObject({ year: 2026, month: 4, day: 30, hour: 10, minute: 30 });
  });

  it("闰年 2 月 29 日 + 12 个月 → 次年 2 月 28 日", () => {
    const start = zonedTimeToUtc({ year: 2024, month: 2, day: 29, hour: 8, minute: 0, second: 0 }, SH);
    const result = addDuration(start, { unit: "month", value: 12 }, SH);
    const parts = getZonedParts(result!, SH);
    expect(parts).toMatchObject({ year: 2025, month: 2, day: 28, hour: 8 });
  });

  it("12 月 31 日 + 3 个月跨年 → 次年 3 月 31 日", () => {
    const start = zonedTimeToUtc({ year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59 }, SH);
    const parts = getZonedParts(addDuration(start, { unit: "month", value: 3 }, SH)!, SH);
    expect(parts).toMatchObject({ year: 2027, month: 3, day: 31 });
  });

  it("季度不等于固定 90 天（1 月 31 日为例）", () => {
    const start = zonedTimeToUtc({ year: 2026, month: 1, day: 31, hour: 0, minute: 0, second: 0 }, SH);
    const quarter = addDuration(start, { unit: "month", value: 3 }, SH)!;
    const ninetyDays = addDuration(start, { unit: "day", value: 90 }, SH)!;
    expect(quarter.getTime()).not.toBe(ninetyDays.getTime());
    expect(quarter.getTime()).toBeLessThan(ninetyDays.getTime());
  });

  it("daysInMonth 正确", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("addCalendarMonths 保持时区墙钟时间", () => {
    const start = zonedTimeToUtc({ year: 2026, month: 6, day: 15, hour: 9, minute: 15, second: 0 }, NY);
    const parts = getZonedParts(addCalendarMonths(start, 1, NY), NY);
    expect(parts).toMatchObject({ month: 7, day: 15, hour: 9, minute: 15 });
  });
});

describe("lifetime 与参数校验", () => {
  it("永久授权返回 null", () => {
    expect(addDuration(new Date(), { unit: "lifetime", value: 0 }, SH)).toBeNull();
  });

  it("非永久且 value ≤ 0 抛错", () => {
    expect(() => addDuration(new Date(), { unit: "day", value: 0 }, SH)).toThrow();
    expect(() => addDuration(new Date(), { unit: "month", value: -1 }, SH)).toThrow();
  });
});

describe("formatDuration：不允许把季度写成 90 天", () => {
  it("人类可读标签", () => {
    expect(formatDuration({ unit: "day", value: 7 })).toBe("7 天");
    expect(formatDuration({ unit: "month", value: 3 })).toBe("一季度（3 个自然月）");
    expect(formatDuration({ unit: "month", value: 12 })).toBe("一年（12 个自然月）");
    expect(formatDuration({ unit: "lifetime", value: 0 })).toBe("永久");
  });
});

describe("renewalStart：未到期顺延，已过期从当前时间起算", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  it("未到期使用原到期时间", () => {
    const expires = new Date("2026-12-02T00:00:00Z");
    expect(renewalStart(expires, now).toISOString()).toBe(expires.toISOString());
  });
  it("已过期使用当前时间", () => {
    const expires = new Date("2026-10-10T00:00:00Z");
    expect(renewalStart(expires, now).toISOString()).toBe(now.toISOString());
  });
  it("永久授权（null）使用当前时间", () => {
    expect(renewalStart(null, now).toISOString()).toBe(now.toISOString());
  });
});
