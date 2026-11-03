import { describe, expect, it } from "vitest";

import {
  describeCron,
  isExecutableCron,
  matchesCron,
  nextRunAfter,
  parseCron,
  zonedParts,
} from "@/lib/domain/cron";

/** 构造一个 UTC 时刻。 */
const utc = (iso: string) => new Date(iso);

describe("cron 解析", () => {
  it("接受标准五段表达式", () => {
    for (const expr of ["0 3 * * *", "*/15 * * * *", "0 0 1 * *", "30 4 * * 1-5", "0 9,18 * * *"]) {
      expect(parseCron(expr), expr).not.toBeNull();
      expect(isExecutableCron(expr), expr).toBe(true);
    }
  });

  it("拒绝段数不对或含非法字符的表达式", () => {
    for (const expr of ["0 3 * *", "0 3 * * * *", "0 3 L * *", "0 3 ? * *", "0 25 * * *", "60 * * * *", "", "a b c d e"]) {
      expect(parseCron(expr), expr).toBeNull();
    }
  });

  it("7 与 0 都表示周日", () => {
    const withSeven = parseCron("0 3 * * 7");
    const withZero = parseCron("0 3 * * 0");
    expect([...(withSeven?.dayOfWeek ?? [])]).toEqual([0]);
    expect([...(withZero?.dayOfWeek ?? [])]).toEqual([0]);
  });

  it("步长与枚举展开正确", () => {
    const every15 = parseCron("*/15 * * * *");
    expect([...(every15?.minute ?? [])]).toEqual([0, 15, 30, 45]);
    const list = parseCron("0 9,18 * * *");
    expect([...(list?.hour ?? [])]).toEqual([9, 18]);
    const range = parseCron("0 4 * * 1-5");
    expect([...(range?.dayOfWeek ?? [])]).toEqual([1, 2, 3, 4, 5]);
    const stepFrom = parseCron("5/20 * * * *");
    expect([...(stepFrom?.minute ?? [])].slice(0, 3)).toEqual([5, 25, 45]);
  });
});

describe("cron 命中判定", () => {
  it("每天 03:00 只在那一分钟命中", () => {
    const fields = parseCron("0 3 * * *")!;
    expect(matchesCron(fields, utc("2026-11-03T03:00:00Z"), "UTC")).toBe(true);
    expect(matchesCron(fields, utc("2026-11-03T03:01:00Z"), "UTC")).toBe(false);
    expect(matchesCron(fields, utc("2026-11-03T02:59:00Z"), "UTC")).toBe(false);
  });

  it("时区决定「几点」——Asia/Shanghai 的 03:00 是 UTC 前一天 19:00", () => {
    const fields = parseCron("0 3 * * *")!;
    expect(matchesCron(fields, utc("2026-11-02T19:00:00Z"), "Asia/Shanghai")).toBe(true);
    expect(matchesCron(fields, utc("2026-11-03T03:00:00Z"), "Asia/Shanghai")).toBe(false);
  });

  it("工作日表达式在周一到周五命中、周末不命中", () => {
    const fields = parseCron("30 4 * * 1-5")!;
    // 2026-11-03 是周二
    expect(matchesCron(fields, utc("2026-11-03T04:30:00Z"), "UTC")).toBe(true);
    // 2026-11-07 是周六
    expect(matchesCron(fields, utc("2026-11-07T04:30:00Z"), "UTC")).toBe(false);
    // 2026-11-08 是周日
    expect(matchesCron(fields, utc("2026-11-08T04:30:00Z"), "UTC")).toBe(false);
  });

  it("日与周同时限定时按「或」处理（Vixie cron 语义）", () => {
    const fields = parseCron("0 3 1 * 1")!;
    // 2026-12-01 是周二，也不是周一 —— 但命中「1 日」
    expect(matchesCron(fields, utc("2026-12-01T03:00:00Z"), "UTC")).toBe(true);
    // 2026-11-09 是周一
    expect(matchesCron(fields, utc("2026-11-09T03:00:00Z"), "UTC")).toBe(true);
    // 2026-11-10 是周二且不是 1 日
    expect(matchesCron(fields, utc("2026-11-10T03:00:00Z"), "UTC")).toBe(false);
  });

  it("非法时区不会误命中", () => {
    const fields = parseCron("0 3 * * *")!;
    expect(zonedParts(utc("2026-11-03T03:00:00Z"), "Not/AZone")).toBeNull();
    expect(matchesCron(fields, utc("2026-11-03T03:00:00Z"), "Not/AZone")).toBe(false);
  });

  it("夏令时切换日按墙上时间判定", () => {
    const fields = parseCron("0 3 * * *")!;
    // 美东 2026-11-01 结束夏令时：那天有 01:00 两次，但 03:00 仍只有一次
    expect(matchesCron(fields, utc("2026-11-01T08:00:00Z"), "America/New_York")).toBe(true);
    expect(matchesCron(fields, utc("2026-11-01T07:00:00Z"), "America/New_York")).toBe(false);
  });
});

describe("下次执行时刻", () => {
  it("从当前分钟之后开始找", () => {
    const next = nextRunAfter("0 3 * * *", utc("2026-11-03T01:00:30Z"), "UTC");
    expect(next?.toISOString()).toBe("2026-11-03T03:00:00.000Z");
  });

  it("刚好在命中那一分钟内也会跳到下一次（不重复算当前）", () => {
    const next = nextRunAfter("0 3 * * *", utc("2026-11-03T03:00:00Z"), "UTC");
    expect(next?.toISOString()).toBe("2026-11-04T03:00:00.000Z");
  });

  it("表达式无法解析时返回 null", () => {
    expect(nextRunAfter("bad", utc("2026-11-03T00:00:00Z"), "UTC")).toBeNull();
  });
});

describe("人话描述", () => {
  it("每日定时", () => {
    expect(describeCron("0 3 * * *", "Asia/Shanghai")).toBe("每天 03:00（Asia/Shanghai）");
  });

  it("工作日定时", () => {
    expect(describeCron("30 4 * * 1-5", "UTC")).toContain("周一、周二、周三、周四、周五");
  });

  it("每月定时", () => {
    expect(describeCron("0 0 1 * *", "UTC")).toContain("每月 1 日");
  });

  it("解析失败时明确说明而不是抛错", () => {
    expect(describeCron("nope", "UTC")).toContain("无法解析");
  });
});
