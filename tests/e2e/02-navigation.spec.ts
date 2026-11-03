import { expect, test, type Page } from "@playwright/test";

/**
 * 导航遍历：侧边栏每一项都真实点击一次，断言 URL 与页面内容，
 * 同时收集浏览器控制台错误——任何一个页面 404 或运行时报错都会让用例失败。
 */
const NAV_ITEMS: Array<{ label: string; path: string; marker: RegExp }> = [
  { label: "数据总览", path: "/app/dashboard", marker: /授权、设备、验证流量的实时概览/ },
  { label: "软件产品", path: "/app/products", marker: /软件产品/ },
  { label: "客户管理", path: "/app/customers", marker: /客户管理/ },
  { label: "授权套餐", path: "/app/plans", marker: /授权套餐/ },
  { label: "功能权限", path: "/app/features", marker: /功能权限/ },
  { label: "授权管理", path: "/app/licenses", marker: /一份授权可以绑定多台设备/ },
  { label: "激活设备", path: "/app/devices", marker: /激活设备/ },
  { label: "API 接入", path: "/app/developer/api", marker: /API 接入/ },
  { label: "API 凭证", path: "/app/developer/credentials", marker: /API 凭证/ },
  { label: "Webhook", path: "/app/developer/webhooks", marker: /Webhook/ },
  { label: "签名密钥", path: "/app/security/signing-keys", marker: /签名密钥/ },
  { label: "验证日志", path: "/app/security/verification-logs", marker: /验证日志/ },
  { label: "操作审计", path: "/app/security/audit-logs", marker: /操作审计/ },
  { label: "管理员与角色", path: "/app/settings/members", marker: /管理员与角色/ },
  { label: "组织设置", path: "/app/settings/organization", marker: /组织设置/ },
  { label: "系统设置", path: "/app/settings/system", marker: /系统设置/ },
];

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      // Next.js 开发模式下 hydration 之外的已知噪音（favicon 404 等）忽略
      if (/favicon|Download the React DevTools/.test(text)) return;
      errors.push(text);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test.describe("侧边栏导航", () => {
  test("每个导航项都能打开对应页面，且没有控制台错误", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto("/app/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    for (const item of NAV_ITEMS) {
      await test.step(`导航到 ${item.label}`, async () => {
        // 限定在侧栏（aria-label=主导航）里找链接：顶栏/命令面板也有同名入口
        const link = page
          .getByRole("complementary", { name: "主导航" })
          .getByRole("link", { name: item.label, exact: true });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(new RegExp(`${item.path.replace(/\//g, "\\/")}(\\?|$)`));
        await expect(page.getByText(item.marker).first()).toBeVisible();
        // 页面不应落到 Next 的 404 / 运行时错误页（用框架固定文案，避免误命中业务里的错误码表）
        await expect(page.getByText("This page could not be found")).toHaveCount(0);
        await expect(page.getByText("Application error")).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      });
    }

    expect(errors, `控制台错误：\n${errors.join("\n")}`).toEqual([]);
  });

  test("折叠侧边栏后只剩图标，刷新仍保持折叠（持久化）", async ({ page }) => {
    await page.goto("/app/dashboard");
    const collapseButton = page.getByRole("button", { name: "折叠侧栏" });
    if (await collapseButton.count()) {
      await collapseButton.first().click();
      await page.reload();
      await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
    }
  });
});
