import { expect, test } from "@playwright/test";

/**
 * 全路由渲染巡检：确保每个导航目标与详情页都能真正渲染出内容。
 *
 * 这条用例存在的理由：列表页能打开不代表详情页能打开。
 * 之前 `/app/products/[id]` 就在把 `licenseByStatus`（接口返回对象）当成数组 `.map` 时崩过，
 * 只靠导航用例点列表页是发现不了的。
 */

interface Envelope<T> {
  ok: boolean;
  data: T;
}

interface PageResult<T> {
  items: T[];
}

test.describe("全路由渲染巡检", () => {
  test("所有导航目标与详情页均可渲染且无运行时错误", async ({ page, request }) => {
    // 直接用同一个 storageState 的 request 取真实 id，避免把 uuid 写死在用例里。
    const pick = async <T,>(path: string): Promise<T> => {
      const res = await request.get(path);
      expect(res.ok(), `${path} 应返回 2xx，实际 ${res.status()}`).toBeTruthy();
      const body = (await res.json()) as Envelope<T>;
      return body.data;
    };

    const [licenses, products, customers, webhooks] = await Promise.all([
      pick<PageResult<{ id: string }>>("/api/v1/admin/licenses?pageSize=1"),
      pick<PageResult<{ id: string }>>("/api/v1/admin/products?pageSize=1"),
      pick<PageResult<{ id: string }>>("/api/v1/admin/customers?pageSize=1"),
      pick<PageResult<{ id: string }>>("/api/v1/admin/webhooks?pageSize=1"),
    ]);

    const routes: Array<{ path: string; heading: string }> = [
      { path: "/app/dashboard", heading: "你好" },
      { path: "/app/products", heading: "软件产品" },
      { path: `/app/products/${products.items[0].id}`, heading: "" },
      { path: "/app/customers", heading: "客户管理" },
      { path: `/app/customers/${customers.items[0].id}`, heading: "" },
      { path: "/app/plans", heading: "授权套餐" },
      { path: "/app/features", heading: "功能权限" },
      { path: "/app/licenses", heading: "授权管理" },
      { path: `/app/licenses/${licenses.items[0].id}`, heading: "" },
      { path: "/app/devices", heading: "激活设备" },
      { path: "/app/developer/api", heading: "API 接入" },
      { path: "/app/developer/credentials", heading: "API 凭证" },
      { path: "/app/developer/webhooks", heading: "Webhook" },
      { path: `/app/developer/webhooks/${webhooks.items[0].id}`, heading: "投递记录" },
      { path: "/app/security/signing-keys", heading: "签名密钥" },
      { path: "/app/security/verification-logs", heading: "验证日志" },
      { path: "/app/security/audit-logs", heading: "操作审计" },
      { path: "/app/settings/members", heading: "管理员与角色" },
      { path: "/app/settings/organization", heading: "组织设置" },
      { path: "/app/settings/system", heading: "系统设置" },
      { path: "/app/settings/backups", heading: "备份与灾备" },
      { path: "/app/settings/profile", heading: "个人设置" },
    ];

    const problems: string[] = [];

    for (const route of routes) {
      const errors: string[] = [];
      const onPageError = (error: Error) => errors.push(`pageerror: ${error.message}`);
      const onConsole = (message: { type: () => string; text: () => string }) => {
        if (message.type() !== "error") return;
        const text = message.text();
        // 登录态探测会先拿到一次 401，这是预期噪音；favicon 同理。
        if (/favicon|DevTools|401 \(Unauthorized\)/.test(text)) return;
        errors.push(`console: ${text}`);
      };
      const onResponse = (response: { status: () => number; url: () => string }) => {
        if (response.status() < 400) return;
        errors.push(`http ${response.status()} ${response.url()}`);
      };

      page.on("pageerror", onPageError);
      page.on("console", onConsole);
      page.on("response", onResponse);

      const response = await page.goto(route.path, { waitUntil: "networkidle" });
      await expect(page.locator("h1").first()).toBeVisible();

      if (route.heading) {
        await expect(page.locator("h1").first()).toContainText(route.heading);
      }
      if ((response?.status() ?? 200) >= 400) {
        errors.push(`navigation status ${response?.status()}`);
      }

      page.off("pageerror", onPageError);
      page.off("console", onConsole);
      page.off("response", onResponse);

      if (errors.length > 0) problems.push(`${route.path} → ${errors.join(" | ")}`);
    }

    expect(problems, `以下路由存在运行时或网络错误：\n${problems.join("\n")}`).toEqual([]);
  });
});
