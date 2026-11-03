import { expect, test } from "@playwright/test";

// 未登录场景：每条用例开始前清空 setup 项目保存的会话 cookie。
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("登录与访问控制", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("未登录访问后台会跳到登录页并带上 next 参数", async ({ page }) => {
    await page.goto("/app/licenses");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Flicenses$/);
    await expect(page.getByRole("heading", { name: "登录授权管理后台" })).toBeVisible();
  });

  test("错误密码给出统一提示，不泄露账号是否存在", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("邮箱").fill("owner@xinglan.dev");
    await page.getByLabel("密码").fill("wrong-password-123");
    await page.getByRole("button", { name: "登录" }).click();
    // 服务端对「密码错误」和「账号不存在」返回同一句提示
    await expect(page.getByText("邮箱或密码不正确")).toBeVisible();
  });

  test("正确凭据登录后进入数据总览，并可退出登录", async ({ page }) => {
    await page.goto("/login?next=/app/licenses");
    await page.getByLabel("邮箱").fill("owner@xinglan.dev");
    await page.getByLabel("密码").fill("License#2026");
    await page.getByRole("button", { name: "登录" }).click();

    await expect(page).toHaveURL(/\/app\/licenses$/);
    await expect(page.getByRole("heading", { name: "授权管理", level: 1 })).toBeVisible();

    // 退出登录后再访问后台应回到登录页：Topbar 的用户菜单是 Dropdown，展开后点「退出登录」
    const accountMenu = page.getByRole("button", { name: /^账户菜单/ });
    await expect(accountMenu).toBeVisible();
    await accountMenu.click();
    await page.getByRole("menuitem", { name: "退出登录" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/app/dashboard");
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});
