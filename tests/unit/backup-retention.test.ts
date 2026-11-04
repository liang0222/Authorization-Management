import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION,
  dayBucket,
  monthBucket,
  normalizeRetention,
  planRetention,
  planStagingSweep,
  weekBucket,
  type RetentionCandidate,
  type StagingSweepEntry,
} from "@/lib/services/backup/retention";

/**
 * 备份保留策略（规格 16.11.3）。
 *
 * 这块逻辑的特点是「写错了不会立刻报错」：多删一份要到需要恢复时才发现，
 * 少删一份只是磁盘慢慢涨。所以每条规则都用**写死的日期与预期集合**钉住，
 * 包括跨年周这种最容易算错一天就全错的地方。
 */

function candidate(backupId: string, iso: string): RetentionCandidate {
  return { backupId, createdAt: new Date(iso) };
}

describe("retention_json 归一", () => {
  it("缺失或非对象时回落到默认值", () => {
    expect(normalizeRetention(null)).toEqual(DEFAULT_RETENTION);
    expect(normalizeRetention(undefined)).toEqual(DEFAULT_RETENTION);
    expect(normalizeRetention("7/4/6")).toEqual(DEFAULT_RETENTION);
    expect(normalizeRetention([7, 4, 6])).toEqual(DEFAULT_RETENTION);
    expect(normalizeRetention({})).toEqual(DEFAULT_RETENTION);
  });

  it("部分字段缺失时只回落缺失的那一项", () => {
    expect(normalizeRetention({ daily: 3 })).toEqual({ daily: 3, weekly: 4, monthly: 6 });
  });

  it("字符串数字能读（历史手写 SQL 塞进来的行）", () => {
    expect(normalizeRetention({ daily: "14", weekly: "2", monthly: "12" })).toEqual({ daily: 14, weekly: 2, monthly: 12 });
  });

  it("越界值夹到 schema 允许的范围，daily 不允许 0", () => {
    expect(normalizeRetention({ daily: 0, weekly: -1, monthly: 999 })).toEqual({ daily: 1, weekly: 0, monthly: 120 });
    expect(normalizeRetention({ daily: 9999, weekly: 9999 })).toEqual({ daily: 365, weekly: 104, monthly: 6 });
  });

  it("小数与 NaN 被截断成整数", () => {
    expect(normalizeRetention({ daily: 7.9, weekly: Number.NaN })).toEqual({ daily: 7, weekly: 4, monthly: 6 });
  });
});

describe("时间桶", () => {
  it("日期桶按 UTC 取 YYYY-MM-DD", () => {
    expect(dayBucket(new Date("2026-11-03T19:00:00.000Z"))).toBe("2026-11-03");
    // 北京时间 11-04 03:00 的备份，UTC 仍是 11-03 —— 一天一份不会因此变成两份
    expect(dayBucket(new Date("2026-11-03T19:00:00.000Z"))).toBe(dayBucket(new Date("2026-11-03T03:00:00.000Z")));
  });

  it("月份桶按 UTC 取 YYYY-MM", () => {
    expect(monthBucket(new Date("2026-11-30T23:59:59.000Z"))).toBe("2026-11");
    expect(monthBucket(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12");
  });

  it("ISO 周桶：周一为一周之始，周日归前一周", () => {
    // 2026-11-02 是周一，11-08 是周日，两者同属 W45
    expect(weekBucket(new Date("2026-11-02T00:00:00.000Z"))).toBe("2026-W45");
    expect(weekBucket(new Date("2026-11-08T23:59:59.000Z"))).toBe("2026-W45");
    expect(weekBucket(new Date("2026-11-09T00:00:00.000Z"))).toBe("2026-W46");
  });

  it("ISO 周桶：跨年周归属周四所在的那一年", () => {
    // 2027-01-01 是周五，它所在的周（2026-12-28 周一 ~ 2027-01-03 周日）周四落在 2026-12-31
    expect(weekBucket(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-W53");
    // 2026-01-01 是周四，属于 2026-W01
    expect(weekBucket(new Date("2026-01-01T12:00:00.000Z"))).toBe("2026-W01");
  });
});

describe("保留计划 planRetention", () => {
  it("空候选返回空计划", () => {
    expect(planRetention([], DEFAULT_RETENTION)).toEqual({ keep: [], purge: [] });
  });

  it("同一天多次备份只留最新一份（daily 桶）", () => {
    const plan = planRetention(
      [
        candidate("bkp_a", "2026-11-03T19:00:00.000Z"),
        candidate("bkp_b", "2026-11-03T10:00:00.000Z"),
        candidate("bkp_c", "2026-11-03T01:00:00.000Z"),
      ],
      { daily: 7, weekly: 0, monthly: 0 },
    );
    expect(plan.keep.map((item) => item.backupId)).toEqual(["bkp_a"]);
    expect(plan.purge).toEqual(["bkp_b", "bkp_c"]);
  });

  it("daily=7 时保留最近 7 个日期桶，第 8 天起被清", () => {
    const days = Array.from({ length: 10 }, (_, index) => {
      const day = String(3 + index).padStart(2, "0");
      return candidate(`bkp_d${index}`, `2026-11-${day}T19:00:00.000Z`);
    });
    const plan = planRetention(days, { daily: 7, weekly: 0, monthly: 0 });
    expect(plan.keep).toHaveLength(7);
    // 保留的是最新的 7 天：d9..d3
    expect(plan.purge).toEqual(["bkp_d2", "bkp_d1", "bkp_d0"]);
  });

  it("三档取并集：每个周桶只留最新一份，daily 超期的旧周被 weekly 救回", () => {
    // 每天一份，从 2026-10-20 起共 14 天（10-20 ~ 11-02），跨 3 个 ISO 周：
    //   W43 = 10-20 ~ 10-25，W44 = 10-26 ~ 11-01，W45 = 11-02
    // daily=7 → 留 10-27 ~ 11-02（013..007）
    // weekly=4 → 每个周桶只留最新一份：W45 的 013（daily 已留）、
    //            W44 的 012（daily 已留）、W43 的 005（10-25）→ 只有 005 是新增保留
    // 所以 10-26 的 006 会被删：它属于 W44，而 W44 的代表是更新的 012。
    // 这正是 GFS「每周留一份」的定义，不是「整周全留」。
    const days = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 20 + index, 19, 0, 0));
      return candidate(`bkp_w${String(index).padStart(2, "0")}`, date.toISOString());
    });
    const plan = planRetention(days, { daily: 7, weekly: 4, monthly: 0 });

    expect(plan.keep.map((item) => `${item.backupId}:${item.rule}`)).toEqual([
      "bkp_w13:daily",
      "bkp_w12:daily",
      "bkp_w11:daily",
      "bkp_w10:daily",
      "bkp_w09:daily",
      "bkp_w08:daily",
      "bkp_w07:daily",
      "bkp_w05:weekly",
    ]);
    expect(plan.purge).toEqual(["bkp_w06", "bkp_w04", "bkp_w03", "bkp_w02", "bkp_w01", "bkp_w00"]);
  });

  it("三档取并集：daily 与 weekly 都覆盖不到时才删", () => {
    // 60 天每天一份（2026-09-01 起），daily=7 / weekly=4 / monthly=0：
    // 最近 7 天由 daily 留，再往前 3 个整周各留最新一份（第 4 周与 daily 重叠），
    // 合计 9 份；其余 51 份被删。删掉的一定比留下的旧。
    const days = Array.from({ length: 60 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 8, 1 + index, 19, 0, 0));
      return candidate(`bkp_l${String(index).padStart(3, "0")}`, date.toISOString());
    });
    const plan = planRetention(days, { daily: 7, weekly: 4, monthly: 0 });

    expect(plan.keep).toHaveLength(9);
    expect(plan.purge).toHaveLength(51);
    expect(plan.keep.filter((item) => item.rule === "daily")).toHaveLength(7);
    expect(plan.keep.filter((item) => item.rule === "weekly")).toHaveLength(2);

    // GFS 的关键性质：每个 weekly 保留项都必须是它所在周桶里最新的一份。
    // 也就是说「同周但更旧」的被删，而不是「只删最旧的连续一段」——
    // 后者会把某一整周留空，那周想回滚就没备份了。
    const byId = new Map(days.map((item) => [item.backupId, item.createdAt]));
    for (const kept of plan.keep.filter((item) => item.rule === "weekly")) {
      const keptWeek = weekBucket(byId.get(kept.backupId)!);
      const sameWeekPurged = plan.purge.filter((id) => weekBucket(byId.get(id)!) === keptWeek);
      for (const id of sameWeekPurged) {
        expect(byId.get(id)!.getTime()).toBeLessThan(byId.get(kept.backupId)!.getTime());
      }
    }
  });

  it("weekly=0 与 monthly=0 时退化为纯 daily", () => {
    const plan = planRetention(
      [candidate("bkp_x", "2026-11-03T19:00:00.000Z"), candidate("bkp_y", "2026-10-03T19:00:00.000Z")],
      { daily: 1, weekly: 0, monthly: 0 },
    );
    expect(plan.keep.map((item) => item.backupId)).toEqual(["bkp_x"]);
    expect(plan.purge).toEqual(["bkp_y"]);
  });

  it("最新一份永不删除（哪怕配置全为 0）", () => {
    const plan = planRetention(
      [candidate("bkp_old", "2020-01-01T00:00:00.000Z"), candidate("bkp_new", "2026-11-03T19:00:00.000Z")],
      { daily: 0, weekly: 0, monthly: 0 },
    );
    // daily 的 schema 下限是 1，但纯函数不该依赖外部校验，这里断言兜底规则
    expect(plan.keep.map((item) => item.backupId)).toEqual(["bkp_new"]);
    expect(plan.keep[0].rule).toBe("newest");
  });

  it("keep 结果按时间倒序，且每条带命中规则便于排障", () => {
    const plan = planRetention(
      [
        candidate("bkp_1", "2026-11-01T19:00:00.000Z"),
        candidate("bkp_2", "2026-11-03T19:00:00.000Z"),
        candidate("bkp_3", "2026-11-02T19:00:00.000Z"),
      ],
      { daily: 7, weekly: 0, monthly: 0 },
    );
    expect(plan.keep.map((item) => item.backupId)).toEqual(["bkp_2", "bkp_3", "bkp_1"]);
    expect(plan.keep.every((item) => item.rule === "daily")).toBe(true);
  });

  it("输入顺序不影响结果（先排序再分桶）", () => {
    const shuffled = [
      candidate("bkp_m", "2026-11-02T19:00:00.000Z"),
      candidate("bkp_n", "2026-11-04T19:00:00.000Z"),
      candidate("bkp_o", "2026-11-03T19:00:00.000Z"),
    ];
    const plan = planRetention(shuffled, { daily: 2, weekly: 0, monthly: 0 });
    expect(plan.keep.map((item) => item.backupId)).toEqual(["bkp_n", "bkp_o"]);
    expect(plan.purge).toEqual(["bkp_m"]);
  });

  it("同一 backupId 重复出现时不会重复保留或重复删除", () => {
    const plan = planRetention(
      [candidate("bkp_dup", "2026-11-03T19:00:00.000Z"), candidate("bkp_dup", "2026-11-03T19:00:00.000Z")],
      { daily: 7, weekly: 0, monthly: 0 },
    );
    expect(plan.keep.map((item) => item.backupId)).toEqual(["bkp_dup"]);
    expect(plan.purge).toEqual([]);
  });
});

describe("暂存目录清扫 planStagingSweep", () => {
  /**
   * 保留策略只看得到「挂在策略上且成功过」的作业，磁盘上还有两类文件它碰不到：
   * 孤儿文件（作业行已不存在）、失败作业的暂存文件（被 status 过滤掉）。
   * 后者不能立刻删 —— `retryJobTarget()` 要靠 local_path 重传，所以给宽限期。
   */
  const NOW = new Date("2026-11-04T00:00:00.000Z");
  const GRACE = { orphanMs: 3_600_000, failedMs: 7 * 86_400_000 };

  function entry(backupId: string, hoursAgo: number, job: StagingSweepEntry["job"]): StagingSweepEntry {
    return { backupId, modifiedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000), job };
  }

  it("孤儿文件：过了 1 小时登记窗口就删（没有作业行就没有重传价值）", () => {
    const plan = planStagingSweep(
      [entry("bkp_old", 24 * 30, null), entry("bkp_fresh", 0.5, null)],
      NOW,
      GRACE,
    );
    expect(plan.delete).toEqual(["bkp_old"]);
    expect(plan.keep).toEqual(["bkp_fresh"]);
  });

  it("孤儿文件与失败作业用不同宽限期：孤儿立刻清，失败作业留 7 天", () => {
    const plan = planStagingSweep(
      [
        entry("bkp_orphan", 2, null),
        entry("bkp_failed", 2, { status: "failed", purgedAt: null }),
      ],
      NOW,
      GRACE,
    );
    // 同样是 2 小时前：孤儿删，失败作业留
    expect(plan.delete).toEqual(["bkp_orphan"]);
    expect(plan.keep).toEqual(["bkp_failed"]);
  });

  it("失败作业在宽限期内保留（重传还要用它的暂存文件）", () => {
    const plan = planStagingSweep([entry("bkp_fail", 3, { status: "failed", purgedAt: null })], NOW, GRACE);
    expect(plan.keep).toEqual(["bkp_fail"]);
    expect(plan.delete).toEqual([]);
  });

  it("失败作业超过宽限期才删", () => {
    const plan = planStagingSweep([entry("bkp_fail", 24 * 10, { status: "failed", purgedAt: null })], NOW, GRACE);
    expect(plan.delete).toEqual(["bkp_fail"]);
  });

  it("成功作业永远不删（那是保留策略的职责）", () => {
    const plan = planStagingSweep(
      [
        entry("bkp_ok", 24 * 400, { status: "succeeded", purgedAt: null }),
        entry("bkp_partial", 24 * 400, { status: "partial", purgedAt: null }),
        entry("bkp_degraded", 24 * 400, { status: "degraded", purgedAt: null }),
      ],
      NOW,
      GRACE,
    );
    expect(plan.delete).toEqual([]);
    expect(plan.keep).toHaveLength(3);
  });

  it("正在跑或排队的作业一律保留", () => {
    const plan = planStagingSweep(
      [
        entry("bkp_running", 24 * 30, { status: "running", purgedAt: null }),
        entry("bkp_queued", 24 * 30, { status: "queued", purgedAt: null }),
      ],
      NOW,
      GRACE,
    );
    expect(plan.delete).toEqual([]);
  });

  it("已被保留策略清过却又出现同名文件 → 直接删（手工拷回的残留）", () => {
    const plan = planStagingSweep(
      [entry("bkp_back", 1, { status: "succeeded", purgedAt: new Date("2026-10-01T00:00:00.000Z") })],
      NOW,
      GRACE,
    );
    expect(plan.delete).toEqual(["bkp_back"]);
  });
});
