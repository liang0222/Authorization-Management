import { describe, expect, it } from "vitest";
import { demoAccountBootCheck, demoAccountIssuesFromRows, DEMO_DISPLAY_NAMES } from "@/lib/demo-accounts";

/**
 * 生产库演示账号检测（阶段 2）。
 *
 * 命中路径：`DEPLOYMENT_ENV=production` 且库里还有 seed 建的那三个账号。
 * 这时它是一条启动闸门 issue，生产构建会拒绝启动。
 * 另外两条路径必须安全：非生产不查；查库失败（表还没建）只警告，不拦启动。
 */
describe("演示账号检测", () => {
  it("命中：每个账号一条 issue，带上邮箱与 displayName", () => {
    const issues = demoAccountIssuesFromRows([
      { email: "owner@xinglan.dev", display_name: "陈星岚" },
      { email: "ops@xinglan.dev", display_name: "林可" },
      { email: "audit@xinglan.dev", display_name: "周睿（审计）" },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain("owner@xinglan.dev");
    expect(issues[0]).toContain("陈星岚");
    expect(issues.join("\n")).toContain("公开的演示口令");
  });

  it("没有命中：返回空数组", () => {
    expect(demoAccountIssuesFromRows([])).toEqual([]);
  });

  it("按邮箱去重（大小写不敏感）", () => {
    const issues = demoAccountIssuesFromRows([
      { email: "Owner@Xinglan.dev", display_name: "陈星岚" },
      { email: "owner@xinglan.dev", display_name: "陈星岚" },
    ]);
    expect(issues).toHaveLength(1);
  });

  it("displayName 缺失时也能描述", () => {
    const issues = demoAccountIssuesFromRows([{ email: "ops@xinglan.dev", display_name: null }]);
    expect(issues[0]).toContain("ops@xinglan.dev");
    expect(issues[0]).not.toContain("displayName=undefined");
  });

  it("seed 的 display_name 名单有 3 个，与 seed 实际写入的一致", () => {
    expect([...DEMO_DISPLAY_NAMES]).toEqual(["陈星岚", "林可", "周睿（审计）"]);
  });

  it("非生产不查库：finder 一次都不该被调用", async () => {
    let calls = 0;
    const check = await demoAccountBootCheck("development", async () => {
      calls += 1;
      return [];
    });
    expect(calls).toBe(0);
    expect(check.issues).toEqual([]);
    expect(check.warning).toBeUndefined();
  });

  it("生产 + 命中：issues 直接透传给启动闸门", async () => {
    const check = await demoAccountBootCheck("production", async () => ["演示账号 owner@xinglan.dev"]);
    expect(check.issues).toEqual(["演示账号 owner@xinglan.dev"]);
    expect(check.warning).toBeUndefined();
  });

  it("生产 + 查库失败：降级为警告，不当成 issue", async () => {
    const check = await demoAccountBootCheck("production", async () => {
      throw new Error('The table `public.users` does not exist in the current database.');
    });
    expect(check.issues).toEqual([]);
    expect(check.warning).toContain("查询 users 表失败");
    expect(check.warning).toContain("does not exist");
  });
});
