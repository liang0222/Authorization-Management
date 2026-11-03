import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright 端到端测试：真实跑在 dev server + PostgreSQL 种子数据之上。
 * 不 mock 任何接口——页面上的按钮点下去就是真实的管理 API。
 *
 * 运行前提：`docker ps` 能看到 licensing-pg、`npm run db:seed` 已执行。
 * 运行方式：`npm run e2e`（webServer 会复用已在跑的开发服务器）。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    // 默认跑生产构建（next start），避免开发模式按需编译造成的超时抖动。
    // 想对 dev server 跑：E2E_BASE_URL=http://127.0.0.1:3000 npm run e2e
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "tests/e2e/.auth/owner.json" },
      dependencies: ["setup"],
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], storageState: "tests/e2e/.auth/owner.json" },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: {
    // 需要先 `npm run build`；这里只负责把生产服务器拉起来。
    command: "node node_modules/next/dist/bin/next start -p 3001",
    url: "http://127.0.0.1:3001/api/v1/auth/session",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
