import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";

/**
 * 这里保存的是**真实会话 cookie**，所以 `tests/e2e/.auth/` 在 .gitignore 里，
 * 打包分发时也不会带上。目录每次 setup 现场创建。
 */
const OWNER_STATE = "tests/e2e/.auth/owner.json";

/** 用真实登录接口建立会话，后续用例直接复用 cookie（lic_session + lic_csrf）。 */
setup("登录所有者账号并保存会话", async ({ request }) => {
  const response = await request.post("/api/v1/auth/login", {
    data: { email: "owner@xinglan.dev", password: "License#2026" },
  });
  expect(response.ok(), `登录失败：${response.status()} ${await response.text()}`).toBeTruthy();
  const body = await response.json();
  expect(body.data.user.email).toBe("owner@xinglan.dev");
  await mkdir(dirname(OWNER_STATE), { recursive: true });
  await request.storageState({ path: OWNER_STATE });
});
