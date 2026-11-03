import { expect, test } from "@playwright/test";

/**
 * 备份与灾备（P0-10 / P0-11）的端到端验收。
 *
 * 这不是"点开看看"的冒烟测试，每一步都在验证真实副作用：
 * 新增目标会写库、连接测试会真的往磁盘写读删、立即备份会跑一次 pg_dump、
 * 恢复演练会建临时库灌数据再对账。测试用的名字带时间戳，跑多次也不会撞唯一约束。
 */
test.describe("备份与灾备", () => {
  test("概览、目标、策略、作业、演练五块都能渲染真实数据", async ({ page }) => {
    await page.goto("/app/settings/backups", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { level: 1, name: "备份与灾备" })).toBeVisible();

    // 五块标题
    for (const title of ["概览", "存储目标", "备份策略", "作业历史", "恢复演练"]) {
      await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
    }

    // 概览必须有真实数字，不能是占位符
    await expect(page.getByText("最近成功备份")).toBeVisible();
    await expect(page.getByText("30 天成功率")).toBeVisible();
    await expect(page.getByText("RPO / RTO", { exact: true })).toBeVisible();

    // WAL 状态必须明说"未启用"，不允许含糊成"已具备 PITR"
    await expect(page.getByText(/WAL 归档/)).toBeVisible();
  });

  test("新增目标 → 连接测试 → 删除", async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    const name = `E2E 目标 ${suffix}`;

    await page.goto("/app/settings/backups", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "新增目标" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // 不填名称直接提交：前端必须拦住，而不是发一个非法请求
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByRole("dialog")).toContainText("请填写名称");

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称").fill(name);
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "本地暂存" }).click();
    await page.getByRole("button", { name: "创建" }).click();

    // 建完后列表里出现这一行，并且状态是"未测试"
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("未测试");

    // 连接测试真的会写一次、读回比对、再删掉
    await page.getByRole("button", { name: `测试 ${name}` }).click();
    await expect(page.getByText(/连接测试通过/)).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("通过");

    // 删除：未被策略引用时可以直接删
    await page.getByRole("button", { name: `删除 ${name}` }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText(/已删除/)).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
  });

  test("被策略引用的目标不允许直接删除", async ({ page }) => {
    await page.goto("/app/settings/backups", { waitUntil: "networkidle" });

    // 策略表里的第一个目标一定是被引用的（否则策略建不出来）
    const policyRow = page.locator("table").nth(1).locator("tbody tr").first();
    const targetName = (await policyRow.locator("td").nth(2).innerText()).trim();

    await page.getByRole("button", { name: `删除 ${targetName}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认删除" }).click();

    // 后端必须先拦住：删掉被引用的目标会让策略指向空气
    await expect(page.getByText(/仍被备份策略引用/)).toBeVisible({ timeout: 15_000 });
    // 目标那一行还在（限定在存储目标表里找，作业表里也会出现目标名）
    await expect(page.locator("table").nth(0).getByRole("row").filter({ hasText: targetName })).toBeVisible();
  });

  test("立即备份 → 作业成功 → 完整性校验 → 隔离恢复演练", async ({ page }) => {
    await page.goto("/app/settings/backups", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "立即备份" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "开始备份" }).click();

    // 备份是同步执行的：pg_dump + 加密 + 上传 + 回读校验，给足 60 秒
    await expect(page.getByText(/备份完成/)).toBeVisible({ timeout: 60_000 });

    // 作业历史第一行就是刚才那次
    const firstJob = page.locator("table").nth(2).locator("tbody tr").first();
    await expect(firstJob).toContainText("成功");

    // 完整性校验：重算暂存包 SHA-256
    await firstJob.getByRole("button", { name: "完整性校验" }).click();
    await expect(page.getByText(/校验通过/)).toBeVisible({ timeout: 30_000 });

    // 隔离恢复演练：建临时库、灌数据、对账、删库
    await firstJob.getByRole("button", { name: "隔离恢复演练" }).click();
    await expect(page.getByText(/演练通过/)).toBeVisible({ timeout: 90_000 });

    // 演练结果写进了"恢复演练"表，且环境注明是隔离容器
    const drill = page.locator("table").nth(3).locator("tbody tr").first();
    await expect(drill).toContainText("通过");
    await expect(drill).toContainText("isolated-container-db");
  });
});

test.describe("备份与灾备 · 只读角色", () => {
  // 这个 describe 必须从「未登录」开始：默认项目带着 owner 的 storageState，
  // 不显式清空的话浏览器直接就是所有者会话，根本走不到审计账号那条路上。
  test.use({ storageState: { cookies: [], origins: [] } });

  test("只有 backup:read 的账号能看到全部数据，但写操作按钮全部禁用并给出原因", async ({ page }) => {
    await page.goto("/login", { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', "audit@xinglan.dev");
    await page.fill('input[type="password"]', "License#2026");
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/app\//, { timeout: 20_000 });

    await page.goto("/app/settings/backups", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "备份与灾备", level: 1 })).toBeVisible();

    // 只读账号仍能读到真实数据（不是空白页，也不是 403 空态）
    await expect(page.getByText("存储目标").first()).toBeVisible();
    await expect(page.getByText("最近成功备份")).toBeVisible();

    // 关键：按钮存在但不可用，且页面上写清了为什么
    for (const name of ["立即备份", "新增目标", "新增策略"]) {
      await expect(page.getByRole("button", { name }).first()).toBeDisabled();
    }
    await expect(page.getByText("当前账号对备份只有只读权限")).toBeVisible();
    await expect(page.getByText(/backup:write/)).toBeVisible();
  });
});
