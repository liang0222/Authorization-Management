import { expect, test } from "@playwright/test";

/**
 * 授权签发闭环：抽屉表单 → 真实 POST /api/v1/admin/licenses → 一次性展示兑换码
 * → 用兑换码后四位在列表里检索到这条新授权。全程不 mock。
 */
test.describe("签发授权", () => {
  test("从列表页签发一份授权，并能按兑换码检索到", async ({ page }) => {
    await page.goto("/app/licenses");
    await page.getByRole("button", { name: "签发授权" }).first().click();

    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("签发授权")).toBeVisible();

    // 选择产品（Radix Select）
    await drawer.locator("#product").click();
    await page.getByRole("option", { name: "FluxPanel 桌面版" }).click();

    // 选择客户
    await drawer.locator("#customer").click();
    await page.getByRole("option").first().click();

    await drawer.getByRole("button", { name: "签发并生成兑换码" }).click();

    // 成功后面板切换为一次性兑换码展示
    await expect(drawer.getByText("授权已签发")).toBeVisible({ timeout: 20_000 });
    const keyText = await drawer.getByText(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){4}$/).first().innerText();
    expect(keyText).toHaveLength(34);

    const last4 = keyText.slice(-4);
    // 结果态只有「继续签发 / 查看授权详情」，用 Escape 收起抽屉（Drawer 的标准关闭手势）
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // 列表搜索：兑换码后四位命中刚签发的授权
    const search = page.getByPlaceholder(/搜索/).first();
    await search.fill(last4);
    await search.press("Enter");
    await expect(page).toHaveURL(new RegExp(`q=${last4}`));
    await expect(page.getByText(new RegExp(last4)).first()).toBeVisible();
  });

  test("表单校验：未选产品与客户时提交按钮不可用", async ({ page }) => {
    await page.goto("/app/licenses");
    await page.getByRole("button", { name: "签发授权" }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("button", { name: "签发并生成兑换码" })).toBeDisabled();
    await page.keyboard.press("Escape");
  });
});
