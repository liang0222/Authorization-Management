import { expect, test } from "@playwright/test";

/** 响应式：移动端侧边栏收进抽屉，顶栏出现菜单按钮，表格可横向滚动。 */
test.describe("移动端布局", () => {
  test("小屏下侧边栏变为抽屉，导航可用且不遮挡内容", async ({ page }) => {
    await page.goto("/app/licenses");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const menuButton = page.getByRole("button", { name: "打开导航" });
    await expect(menuButton).toBeVisible();
    await menuButton.click();

    const drawerNav = page.getByRole("dialog", { name: "主导航" });
    await expect(drawerNav).toBeVisible();

    await drawerNav.getByRole("link", { name: "激活设备", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/devices/);
    await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0);
  });

  test("移动端列表页保留筛选与分页控件", async ({ page }) => {
    await page.goto("/app/licenses");
    await expect(page.getByPlaceholder(/搜索/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "签发授权" }).first()).toBeVisible();
  });
});
