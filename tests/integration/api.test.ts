import { describe, expect, it } from "vitest";

import {
  BASE,
  adminJson,
  desktopContext,
  issueLicense,
  login,
  prepareActivation,
  publicJson,
} from "./support";

describe("认证与 CSRF", () => {
  it("错误密码返回 401 且不泄露账号是否存在", async () => {
    const wrong = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@xinglan.dev", password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);
    const body = await wrong.json();
    expect(body.code).toBe("CLIENT_AUTH_FAILED");
    expect(body.message).toBe("邮箱或密码不正确");

    const unknown = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "whatever" }),
    });
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).message).toBe("邮箱或密码不正确");
  });

  it("未登录访问管理 API 返回 401", async () => {
    const result = await adminJson(null, "/api/v1/admin/licenses");
    expect(result.status).toBe(401);
    expect(result.json.code).toBe("CLIENT_AUTH_FAILED");
  });

  it("写操作缺少 CSRF 头返回 403", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const response = await fetch(`${BASE}/api/v1/admin/licenses`, {
      method: "POST",
      headers: { cookie: `${session.cookie}; lic_csrf=${session.csrf}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("CSRF_FAILED");
  });
});

describe("授权生命周期", () => {
  it("签发 → 暂停 → 恢复 → 撤销；终态不可恢复也不可续费", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const issued = await issueLicense(session, context);
    expect(issued.licenseKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){4}$/);

    const list = await adminJson<{ items: Array<{ id: string; keyMask: string }> }>(
      session,
      `/api/v1/admin/licenses?q=${encodeURIComponent(issued.id)}&pageSize=5`,
    );
    expect(list.status).toBe(200);
    const row = list.json.data!.items.find((item) => item.id === issued.id);
    expect(row).toBeDefined();
    // 列表只返回脱敏兑换码
    expect(row!.keyMask).not.toContain(issued.licenseKey.slice(0, 6));

    const suspend = await adminJson<{ adminStatus: string }>(session, `/api/v1/admin/licenses/${issued.id}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "集成测试暂停" }),
    });
    expect(suspend.status).toBe(200);
    expect(suspend.json.data!.adminStatus).toBe("suspended");

    const resume = await adminJson(session, `/api/v1/admin/licenses/${issued.id}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(resume.status).toBe(200);

    const revoke = await adminJson<{ adminStatus: string }>(session, `/api/v1/admin/licenses/${issued.id}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason: "集成测试撤销" }),
    });
    expect(revoke.status).toBe(200);
    expect(revoke.json.data!.adminStatus).toBe("revoked");

    const resumeAgain = await adminJson(session, `/api/v1/admin/licenses/${issued.id}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(resumeAgain.status).toBe(409);

    const renewRevoked = await adminJson(session, `/api/v1/admin/licenses/${issued.id}/renew`, {
      method: "POST",
      body: JSON.stringify({ duration: { unit: "day", value: 30 } }),
    });
    expect(renewRevoked.status).toBe(409);
  });

  it("续费从原到期时间顺延（未到期）", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    // 固定起算，立即生效，避免依赖首次激活
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const issued = await issueLicense(session, context, {
      startPolicy: "fixed_start",
      startsAt,
      duration: { unit: "day", value: 30 },
    });
    expect(issued.expiresAt).toBeTruthy();

    const before = new Date(issued.expiresAt!).getTime();
    const renew = await adminJson<{ previousExpiresAt: string; newExpiresAt: string; mode: string }>(
      session,
      `/api/v1/admin/licenses/${issued.id}/renew`,
      { method: "POST", body: JSON.stringify({ duration: { unit: "day", value: 30 } }) },
    );
    expect(renew.status).toBe(200);
    expect(renew.json.data!.mode).toBe("append");
    const delta = new Date(renew.json.data!.newExpiresAt).getTime() - before;
    expect(Math.abs(delta - 30 * 86_400_000)).toBeLessThan(5_000);
  });

  it("只读角色不能签发授权（RBAC 服务端校验）", async () => {
    const viewer = await login("audit@xinglan.dev", "License#2026");
    const context = await desktopContext(viewer);
    const result = await adminJson(viewer, "/api/v1/admin/licenses", {
      method: "POST",
      body: JSON.stringify({
        productId: context.productId,
        customerId: context.customerId,
        duration: { unit: "day", value: 7 },
        startPolicy: "on_first_activation",
        maxDevices: 1,
      }),
    });
    expect(result.status).toBe(403);
    expect(result.json.code).toBe("FORBIDDEN");
  });

  it("永久授权拒绝普通期限续费", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const started = new Date(Date.now() - 60_000).toISOString();
    const issued = await issueLicense(session, context, {
      startPolicy: "fixed_start",
      startsAt: started,
      duration: { unit: "lifetime", value: 0 },
    });
    expect(issued.expiresAt).toBeNull();
    const renew = await adminJson(session, `/api/v1/admin/licenses/${issued.id}/renew`, {
      method: "POST",
      body: JSON.stringify({ duration: { unit: "day", value: 30 } }),
    });
    expect(renew.status).toBe(400);
  });
});

describe("公开客户端激活链路", () => {
  it("挑战 → 签名激活 → 心跳轮换 → 权限 → 解绑；旧令牌失效", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const issued = await issueLicense(session, context, { maxDevices: 1, maxActivationCount: 3 });

    const prepared = await prepareActivation(issued.licenseKey, "lifecycle");
    const activation = await publicJson<{
      activation_id: string;
      access_token: string;
      license: { expires_at: string | null };
      entitlements: Record<string, unknown>;
    }>("/api/v1/activations", {
      body: prepared.body,
      idempotencyKey: `it-${issued.id}`,
    });
    expect(activation.status).toBe(201);
    const token = activation.json.data!.access_token;
    expect(token.split(".")).toHaveLength(2);
    expect(activation.json.data!.license.expires_at).toBeTruthy();

    const heartbeat = await publicJson<{ access_token: string; license: { effective_status: string } }>(
      "/api/v1/activations/heartbeat",
      { token },
    );
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.json.data!.license.effective_status).toBe("active");
    // 字段名是 snake_case 的 access_token：这里必须断言到具体形状，
    // 否则读错字段会得到 undefined，而 `undefined !== token` 仍然成立，测试会假通过。
    const rotated = heartbeat.json.data!.access_token;
    expect(typeof rotated).toBe("string");
    expect(rotated.split(".")).toHaveLength(2);
    expect(rotated).not.toBe(token);

    const replay = await publicJson("/api/v1/activations/heartbeat", { token });
    expect(replay.status).toBe(401);

    const entitlements = await publicJson<{ features: Record<string, unknown> }>(
      `/api/v1/activations/${activation.json.data!.activation_id}/entitlements`,
      { method: "GET", token: rotated },
    );
    expect(entitlements.status).toBe(200);
    expect(entitlements.json.data!.features).toBeTypeOf("object");

    const deactivate = await publicJson<{ released: boolean }>("/api/v1/activations/deactivate", {
      token: rotated,
      body: { reason: "集成测试解绑" },
      idempotencyKey: `it-deact-${issued.id}`,
    });
    expect(deactivate.status).toBe(200);
    expect(deactivate.json.data!.released).toBe(true);

    const detail = await adminJson<{ license: { activeDevices: number; activationCount: number } }>(
      session,
      `/api/v1/admin/licenses/${issued.id}`,
    );
    expect(detail.json.data!.license.activeDevices).toBe(0);
    // 默认不返还累计激活次数
    expect(detail.json.data!.license.activationCount).toBe(1);
  });

  it("幂等键：同体重放返回首次结果，不同体返回 409", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const issued = await issueLicense(session, context, { maxDevices: 2 });
    const prepared = await prepareActivation(issued.licenseKey, "idem");
    const key = `it-idem-${issued.id}`;

    const first = await publicJson<{ activation_id: string }>("/api/v1/activations", {
      body: prepared.body,
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);

    const replay = await publicJson<{ activation_id: string }>("/api/v1/activations", {
      body: prepared.body,
      idempotencyKey: key,
    });
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    expect(replay.json.data!.activation_id).toBe(first.json.data!.activation_id);

    const conflict = await publicJson("/api/v1/activations", {
      body: { ...prepared.body, client_version: "9.9.9" },
      idempotencyKey: key,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("并发激活不会突破 max_devices", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const issued = await issueLicense(session, context, { maxDevices: 1, maxActivationCount: 5 });

    const [a, b] = await Promise.all([
      prepareActivation(issued.licenseKey, "race-a"),
      prepareActivation(issued.licenseKey, "race-b"),
    ]);
    const [r1, r2] = await Promise.all([
      publicJson("/api/v1/activations", { body: a.body, idempotencyKey: `race-a-${issued.id}` }),
      publicJson("/api/v1/activations", { body: b.body, idempotencyKey: `race-b-${issued.id}` }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = [r1, r2].find((result) => result.status === 409)!;
    expect(failed.json.code).toBe("DEVICE_LIMIT_EXCEEDED");

    const detail = await adminJson<{ license: { activeDevices: number } }>(
      session,
      `/api/v1/admin/licenses/${issued.id}`,
    );
    expect(detail.json.data!.license.activeDevices).toBe(1);
  });

  it("暂停授权后心跳立即被拒绝（423）", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const issued = await issueLicense(session, context, { maxDevices: 1 });
    const prepared = await prepareActivation(issued.licenseKey, "suspend");
    const activation = await publicJson<{ access_token: string }>("/api/v1/activations", {
      body: prepared.body,
      idempotencyKey: `it-suspend-${issued.id}`,
    });
    expect(activation.status).toBe(201);

    await adminJson(session, `/api/v1/admin/licenses/${issued.id}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "集成测试：暂停后校验" }),
    });

    const heartbeat = await publicJson("/api/v1/activations/heartbeat", {
      token: activation.json.data!.access_token,
    });
    expect(heartbeat.status).toBe(423);
    expect(heartbeat.json.code).toBe("LICENSE_SUSPENDED");
  });
});

describe("功能权限版本（P1-3）", () => {
  it("管理端改功能覆盖后，客户端心跳能看到版本自增与新值", async () => {
    const session = await login("owner@xinglan.dev", "License#2026");
    const context = await desktopContext(session);
    const issued = await issueLicense(session, context, { maxDevices: 1 });

    // 挑一个真实存在的产品功能来覆盖，避免写死编码后产品改名导致假失败。
    const features = await adminJson<{
      items: Array<{ code: string; valueType: string; defaultValue: unknown; status: string }>;
    }>(session, `/api/v1/admin/features?productId=${context.productId}&pageSize=100`);
    expect(features.status).toBe(200);
    const target = features.json.data!.items.find((item) => item.valueType === "boolean" && item.status === "active");
    expect(target, "种子数据里 FluxPanel 桌面版应有启用的布尔功能").toBeTruthy();
    const code = target!.code;

    const prepared = await prepareActivation(issued.licenseKey, "featurever");
    const activation = await publicJson<{
      activation_id: string;
      access_token: string;
      entitlements_version: number;
      entitlements: Record<string, unknown>;
    }>("/api/v1/activations", { body: prepared.body, idempotencyKey: `it-feat-${issued.id}` });
    expect(activation.status).toBe(201);
    expect(activation.json.data!.entitlements_version).toBe(1);
    const before = activation.json.data!.entitlements[code];
    expect(typeof before).toBe("boolean");

    // 心跳先报 v1，确认基线。
    const first = await publicJson<{ entitlements_version: number; entitlements: Record<string, unknown>; access_token: string }>(
      "/api/v1/activations/heartbeat",
      { token: activation.json.data!.access_token },
    );
    expect(first.status).toBe(200);
    expect(first.json.data!.entitlements_version).toBe(1);
    expect(first.json.data!.entitlements[code]).toBe(before);

    // 管理端改成相反值。
    const flipped = !(before as boolean);
    const updated = await adminJson<{ entitlements_version: number; entitlements: Record<string, unknown> }>(
      session,
      `/api/v1/admin/licenses/${issued.id}/features`,
      { method: "PUT", body: JSON.stringify({ overrides: [{ code, value: flipped }] }) },
    );
    expect(updated.status).toBe(200);
    expect(updated.json.data!.entitlements_version).toBe(2);
    expect(updated.json.data!.entitlements[code]).toBe(flipped);

    // 心跳必须反映新版本与新值 —— 这就是客户端判断「要不要重新拉权限」的依据。
    const second = await publicJson<{ entitlements_version: number; entitlements: Record<string, unknown>; access_token: string }>(
      "/api/v1/activations/heartbeat",
      { token: first.json.data!.access_token },
    );
    expect(second.status).toBe(200);
    expect(second.json.data!.entitlements_version).toBe(2);
    expect(second.json.data!.entitlements[code]).toBe(flipped);

    // 清空覆盖：回落默认值，版本继续自增（不能回退，否则客户端会以为没变过）。
    const cleared = await adminJson<{ entitlements_version: number; entitlements: Record<string, unknown> }>(
      session,
      `/api/v1/admin/licenses/${issued.id}/features`,
      { method: "PUT", body: JSON.stringify({ overrides: [] }) },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.data!.entitlements_version).toBe(3);
    expect(cleared.json.data!.entitlements[code]).toBe(before);

    // 越权与非法输入都要被挡住。
    const viewer = await login("audit@xinglan.dev", "License#2026");
    const denied = await adminJson(viewer, `/api/v1/admin/licenses/${issued.id}/features`, {
      method: "PUT",
      body: JSON.stringify({ overrides: [] }),
    });
    expect(denied.status).toBe(403);

    const wrongType = await adminJson(session, `/api/v1/admin/licenses/${issued.id}/features`, {
      method: "PUT",
      body: JSON.stringify({ overrides: [{ code, value: "不是布尔值" }] }),
    });
    expect(wrongType.status).toBe(422);
    expect(wrongType.json.code).toBe("FEATURE_VALUE_INVALID");

    const unknown = await adminJson(session, `/api/v1/admin/licenses/${issued.id}/features`, {
      method: "PUT",
      body: JSON.stringify({ overrides: [{ code: "not_a_real_feature", value: true }] }),
    });
    expect(unknown.status).toBe(422);
    expect(unknown.json.code).toBe("FEATURE_NOT_FOUND");
  });
});
