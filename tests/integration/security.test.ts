import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { adminJson, desktopContext, issueLicense, login, type Session } from "./support";

/**
 * 阶段 5：越权与 SSRF 回归。
 *
 * 全部打真实的 Next.js 实例（TEST_BASE_URL）与真实的 PostgreSQL：
 * - 第二组织直接写库构造，只存在于本次隔离副本指向的临时库；
 * - 登录/CSRF 复用 ./support 里的工具函数，不 mock 权限中间件；
 * - 每个负向用例都把实际响应码打到 stdout，报告里可直接引用。
 *
 * 安全护栏：只允许跑在阶段 5 的临时库上。若环境变量缺失或指向别的库，直接失败，
 * 避免一次误跑把测试数据写进生产 licensing 库。
 */

let prisma: PrismaClient;
let owner: Session;
let viewer: Session;
let operator: Session;
let tenantBAdmin: Session;
let ctxA: Awaited<ReturnType<typeof desktopContext>>;
let userAId: string;
let runSuffix = "";

interface TenantB {
  organizationId: string;
  productId: string;
  customerId: string;
  licenseId: string;
  deviceId: string;
  activationId: string;
  webhookId: string;
  destinationId: string;
  jobId: string;
}

let tenantB: TenantB;

const fixture: { server: Server; port: number; paths: string[]; bodies: Map<string, Buffer> } = {
  server: null as unknown as Server,
  port: 0,
  paths: [],
  bodies: new Map(),
};
const redirectFixture: { server: Server; port: number; internalHits: number } = {
  server: null as unknown as Server,
  port: 0,
  internalHits: 0,
};

function log(label: string, status: number, code: string | undefined) {
  console.log(`[stage5] ${label} -> ${status} ${code ?? ""}`.trim());
}

async function record(label: string, path: string, init?: RequestInit) {
  const result = await adminJson<Record<string, unknown>>(owner, path, init);
  log(label, result.status, typeof result.json.code === "string" ? result.json.code : undefined);
  return result;
}

describe("阶段5 · 越权与 SSRF 回归", () => {
  beforeAll(async () => {
    const dbUrl = process.env.LICENSE_DB_URL ?? "";
    if (!dbUrl.includes("licensing_stage5")) {
      throw new Error(
        `拒绝在非阶段5临时库上运行安全测试（LICENSE_DB_URL=${dbUrl || "<未设置>"}）。` +
          "请使用 licensing_stage5 并指向隔离实例。",
      );
    }

    ({ prisma } = await import("@/lib/db"));
    const { hashPassword } = await import("@/lib/auth/password");

    owner = await login("owner@xinglan.dev", "License#2026");
    viewer = await login("audit@xinglan.dev", "License#2026");
    operator = await login("ops@xinglan.dev", "License#2026");
    ctxA = await desktopContext(owner);

    const ownerA = await prisma.users.findFirstOrThrow({ where: { email: "owner@xinglan.dev" } });
    userAId = ownerA.id;
    // 给 A 组织准备一条真实授权：viewer/operator 的写接口需要一个存在的目标，
    // 同时跨租户写测试失败时也能看出 A 自己的数据是否被误改。
    await issueLicense(owner, ctxA, { notes: "阶段5 安全测试基线" });

    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    runSuffix = suffix;
    const orgB = await prisma.organizations.create({
      data: {
        name: `阶段5 租户B ${suffix}`,
        slug: `stage5-tenant-b-${suffix}`,
        timezone: "Asia/Shanghai",
        settings: {},
      },
    });
    const permissions = await prisma.permissions.findMany({ select: { code: true } });
    const roleB = await prisma.roles.create({
      data: { organization_id: orgB.id, code: "owner", name: "Owner", is_system: true },
    });
    await prisma.role_permissions.createMany({
      data: permissions.map((permission) => ({ role_id: roleB.id, permission_code: permission.code })),
    });
    const userB = await prisma.users.create({
      data: {
        email: `stage5-owner-${suffix}@tenant-b.test`,
        password_hash: await hashPassword("Stage5#TenantB"),
        display_name: "租户B管理员",
        status: "active",
      },
    });
    await prisma.organization_memberships.create({
      data: { organization_id: orgB.id, user_id: userB.id, role_id: roleB.id, status: "active" },
    });
    tenantBAdmin = await login(userB.email, "Stage5#TenantB");

    const productB = await prisma.products.create({
      data: {
        organization_id: orgB.id,
        code: `stage5-product-${suffix}`,
        name: "租户B产品",
        product_type: "desktop",
      },
    });
    const customerB = await prisma.customers.create({
      data: { organization_id: orgB.id, customer_code: `B-${suffix}`, name: "租户B客户" },
    });
    const licenseB = await prisma.licenses.create({
      data: {
        organization_id: orgB.id,
        product_id: productB.id,
        customer_id: customerB.id,
        admin_status: "active",
        duration_unit: "day",
        duration_value: 30,
        max_devices: 1,
        notes: "租户B原始备注",
        created_by: userB.id,
      },
    });
    const deviceB = await prisma.devices.create({
      data: {
        organization_id: orgB.id,
        product_id: productB.id,
        device_instance_id: `stage5-device-b-${suffix}`,
        platform: "windows",
        device_name: "租户B设备",
      },
    });
    const activationB = await prisma.activations.create({
      data: {
        organization_id: orgB.id,
        product_id: productB.id,
        license_id: licenseB.id,
        device_id: deviceB.id,
        status: "active",
      },
    });
    const webhookB = await prisma.webhook_endpoints.create({
      data: {
        organization_id: orgB.id,
        product_id: productB.id,
        url: "https://tenant-b.example.com/hook",
        secret_hash: Buffer.from(`stage5-webhook-${suffix}`),
        event_types: ["license.activated"],
      },
    });
    const destinationB = await prisma.backup_storage_destinations.create({
      data: {
        organization_id: orgB.id,
        name: "租户B本地目标",
        provider_type: "local",
        adapter_type: "native",
        root_path: `/tmp/stage5-tenant-b-${suffix}`,
        auth_method: "none",
      },
    });
    const jobB = await prisma.backup_jobs.create({
      data: {
        organization_id: orgB.id,
        backup_id: `stage5-job-b-${suffix}`,
        status: "failed",
        trigger: "manual",
      },
    });

    tenantB = {
      organizationId: orgB.id,
      productId: productB.id,
      customerId: customerB.id,
      licenseId: licenseB.id,
      deviceId: deviceB.id,
      activationId: activationB.id,
      webhookId: webhookB.id,
      destinationId: destinationB.id,
      jobId: jobB.id,
    };

    // WebDAV 夹具：记录每个请求路径，用来证明探针文件没有写出 root_path。
    fixture.server = createServer((req, res) => {
      fixture.paths.push(req.url ?? "");
      if (req.method === "MKCOL") {
        res.statusCode = 201;
        res.end();
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          fixture.bodies.set(req.url ?? "", Buffer.concat(chunks));
          res.statusCode = 201;
          res.end();
        });
        return;
      }
      if (req.method === "GET") {
        const body = fixture.bodies.get(req.url ?? "");
        res.statusCode = body ? 200 : 404;
        res.end(body ?? "");
        return;
      }
      if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 405;
      res.end();
    });
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    fixture.port = (fixture.server.address() as AddressInfo).port;

    // 302 夹具：Location 指向同源的 /internal，投递层不应跟随。
    redirectFixture.server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/internal");
        res.end();
        return;
      }
      if (req.url === "/internal") {
        redirectFixture.internalHits += 1;
        res.statusCode = 200;
        res.end("should-not-be-reached");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => redirectFixture.server.listen(0, "127.0.0.1", resolve));
    redirectFixture.port = (redirectFixture.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fixture.server?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => redirectFixture.server?.close(() => resolve()) ?? resolve());
    await prisma?.$disconnect();
  });

  describe("跨租户隔离", () => {
    it("组织 A 会话读取组织 B 的六类资源一律 404", async () => {
      const cases: Array<[string, string]> = [
        ["授权详情", `/api/v1/admin/licenses/${tenantB.licenseId}`],
        ["客户详情", `/api/v1/admin/customers/${tenantB.customerId}`],
        ["产品详情", `/api/v1/admin/products/${tenantB.productId}`],
        ["设备详情", `/api/v1/admin/devices/${tenantB.deviceId}`],
        ["Webhook 详情", `/api/v1/admin/webhooks/${tenantB.webhookId}`],
        ["备份目标详情", `/api/v1/admin/backups/destinations/${tenantB.destinationId}`],
        ["备份作业详情", `/api/v1/admin/backups/jobs/${tenantB.jobId}`],
      ];
      for (const [label, path] of cases) {
        const result = await record(`跨租户读 ${label}`, path);
        expect(result.status, `${label} 必须 404 而不是 403/200`).toBe(404);
      }
    });

    it("组织 A 会话写组织 B 的资源一律 404，写后复查 B 数据未变", async () => {
      const before = await snapshotTenantB();
      const writes: Array<[string, string, RequestInit]> = [
        ["PATCH 授权", `/api/v1/admin/licenses/${tenantB.licenseId}`, { method: "PATCH", body: JSON.stringify({ notes: "被跨租户改写" }) }],
        ["暂停授权", `/api/v1/admin/licenses/${tenantB.licenseId}/suspend`, { method: "POST", body: JSON.stringify({ reason: "跨租户操作" }) }],
        ["PATCH 客户", `/api/v1/admin/customers/${tenantB.customerId}`, { method: "PATCH", body: JSON.stringify({ name: "被跨租户改写" }) }],
        ["PATCH 产品", `/api/v1/admin/products/${tenantB.productId}`, { method: "PATCH", body: JSON.stringify({ name: "被跨租户改写" }) }],
        ["PATCH Webhook", `/api/v1/admin/webhooks/${tenantB.webhookId}`, { method: "PATCH", body: JSON.stringify({ url: "https://attacker.example.com/hook" }) }],
        ["PATCH 备份目标", `/api/v1/admin/backups/destinations/${tenantB.destinationId}`, { method: "PATCH", body: JSON.stringify({ name: "被跨租户改写" }) }],
        ["测试备份目标", `/api/v1/admin/backups/destinations/${tenantB.destinationId}/test`, { method: "POST", body: JSON.stringify({}) }],
        ["重传备份作业", `/api/v1/admin/backups/jobs/${tenantB.jobId}/retry`, { method: "POST", body: JSON.stringify({}) }],
        ["解绑激活", `/api/v1/admin/activations/${tenantB.activationId}/release`, { method: "POST", body: JSON.stringify({ reason: "跨租户解绑" }) }],
      ];
      for (const [label, path, init] of writes) {
        const result = await record(`跨租户写 ${label}`, path, init);
        expect(result.status, `${label} 必须 404`).toBe(404);
      }
      expect(await snapshotTenantB()).toEqual(before);
    });

    it("组织 B 管理员仍能读取自己的资源（隔离没有把 B 一起锁死）", async () => {
      const own = await adminJson(tenantBAdmin, `/api/v1/admin/licenses/${tenantB.licenseId}`);
      expect(own.status).toBe(200);
      const foreign = await adminJson(tenantBAdmin, `/api/v1/admin/licenses/${tenantB.licenseId}`);
      expect(foreign.status).toBe(200);
    });
  });

  describe("角色矩阵", () => {
    it("viewer 对全部管理写接口返回 403 且不产生任何数据变化", async () => {
      const before = await snapshotTenantA();
      const licenseA = await prisma.licenses.findFirstOrThrow({
        where: { organization_id: before.organizationId, deleted_at: null },
        orderBy: { created_at: "desc" },
      });
      const randomId = "00000000-0000-4000-8000-000000000000";
      const writes: Array<[string, string, RequestInit]> = [
        ["签发授权", "/api/v1/admin/licenses", { method: "POST", body: JSON.stringify({ productId: ctxA.productId, customerId: ctxA.customerId, duration: { unit: "day", value: 30 } }) }],
        ["续费", `/api/v1/admin/licenses/${licenseA.id}/renew`, { method: "POST", body: JSON.stringify({ duration: { unit: "day", value: 30 } }) }],
        ["暂停", `/api/v1/admin/licenses/${licenseA.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "viewer 尝试" }) }],
        ["撤销", `/api/v1/admin/licenses/${licenseA.id}/revoke`, { method: "POST", body: JSON.stringify({ reason: "viewer 尝试" }) }],
        ["解绑激活", `/api/v1/admin/activations/${randomId}/release`, { method: "POST", body: JSON.stringify({ reason: "viewer 尝试" }) }],
        ["新增成员", "/api/v1/admin/members", { method: "POST", body: JSON.stringify({ email: "viewer-created@example.com", displayName: "viewer", roleCode: "viewer" }) }],
        ["新增角色", "/api/v1/admin/roles", { method: "POST", body: JSON.stringify({ code: "viewer-made", name: "viewer", permissionCodes: ["license:read"] }) }],
        ["组织设置", "/api/v1/admin/organization", { method: "PATCH", body: JSON.stringify({ name: "被 viewer 改写" }) }],
        ["系统设置", "/api/v1/admin/settings", { method: "PATCH", body: JSON.stringify({ webhookMaxRetries: 3 }) }],
        ["新增凭证", "/api/v1/admin/credentials", { method: "POST", body: JSON.stringify({}) }],
        ["新增签名密钥", "/api/v1/admin/signing-keys", { method: "POST", body: JSON.stringify({}) }],
        ["新增 Webhook", "/api/v1/admin/webhooks", { method: "POST", body: JSON.stringify({ productId: ctxA.productId, url: "https://viewer.example.com/hook", eventTypes: ["license.activated"] }) }],
        ["立即备份", "/api/v1/admin/backups/jobs", { method: "POST", body: JSON.stringify({}) }],
      ];
      for (const [label, path, init] of writes) {
        const result = await adminJson(viewer, path, init);
        log(`viewer 写 ${label}`, result.status, typeof result.json.code === "string" ? result.json.code : undefined);
        expect(result.status, `${label} 必须 403`).toBe(403);
        expect(result.json.code, label).toBe("FORBIDDEN");
      }
      expect(await snapshotTenantA()).toEqual(before);
    });

    it("operator 对产品/组织写 403，对签发类放行", async () => {
      const productCreate = await adminJson(operator, "/api/v1/admin/products", {
        method: "POST",
        body: JSON.stringify({ code: "op-stage5", name: "operator 产品", productType: "desktop" }),
      });
      log("operator 写 产品", productCreate.status, String(productCreate.json.code));
      expect(productCreate.status).toBe(403);

      const orgPatch = await adminJson(operator, "/api/v1/admin/organization", {
        method: "PATCH",
        body: JSON.stringify({ name: "operator 改写组织" }),
      });
      log("operator 写 组织", orgPatch.status, String(orgPatch.json.code));
      expect(orgPatch.status).toBe(403);

      const ctx = await desktopContext(operator);
      const issued = await issueLicense(operator, ctx, { notes: "operator 签发放行" });
      expect(issued.id).toBeTruthy();
      const suspend = await adminJson(operator, `/api/v1/admin/licenses/${issued.id}/suspend`, {
        method: "POST",
        body: JSON.stringify({ reason: "operator 可暂停" }),
      });
      log("operator 暂停授权", suspend.status, String(suspend.json.code));
      expect(suspend.status).toBe(200);

      const revoke = await adminJson(operator, `/api/v1/admin/licenses/${issued.id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: "operator 不应撤销" }),
      });
      log("operator 撤销授权", revoke.status, String(revoke.json.code));
      expect(revoke.status).toBe(403);
    });
  });

  describe("SSRF 负向", () => {
    it("创建 Webhook 时拒绝全部内网/元数据/链路本地/ULA 地址", async () => {
      const before = await prisma.webhook_endpoints.count();
      const cases: Array<[string, string, string]> = [
        ["云元数据", "http://169.254.169.254/latest/meta-data/", "内网"],
        ["私网 10/8", "http://10.0.0.5/hook", "内网"],
        ["私网 192.168/16", "http://192.168.1.10/hook", "内网"],
        ["私网 172.16/12", "http://172.16.5.5/hook", "内网"],
        ["CGNAT", "http://100.64.1.1/hook", "内网"],
        ["IPv6 链路本地", "http://[fe80::1]/hook", "内网"],
        ["IPv6 ULA fd00", "http://[fd00::1]/hook", "内网"],
        ["IPv6 ULA fd12", "https://[fd12:3456::1]/hook", "内网"],
        ["IPv6 回环", "http://[::1]:4011/hook", "内网"],
        ["单标签内网短名", "https://metadata/hook", "内网"],
        ["非 https 公网地址", "http://example.com/hook", "https"],
        ["URL 内嵌账密", "https://user:pw@example.com/hook", "账号密码"],
      ];
      for (const [label, url, fragment] of cases) {
        const result = await adminJson(owner, "/api/v1/admin/webhooks", {
          method: "POST",
          body: JSON.stringify({ productId: ctxA.productId, url, eventTypes: ["license.activated"] }),
        });
        log(`SSRF Webhook ${label}`, result.status, String(result.json.code));
        expect(result.status, label).toBe(400);
        expect(result.json.code, label).toBe("INVALID_REQUEST");
        const fieldErrors = (result.json.details as { fieldErrors?: Record<string, string> } | undefined)?.fieldErrors;
        expect(fieldErrors?.url, label).toContain(fragment);
      }
      expect(await prisma.webhook_endpoints.count()).toBe(before);
    });

    it("创建/更新备份 WebDAV/S3 目标时拒绝内网端点", async () => {
      const before = await prisma.backup_storage_destinations.count();
      const target = (name: string, providerType: "webdav" | "s3", endpointUrl: string, extra: Record<string, unknown> = {}) => ({
        name,
        providerType,
        endpointUrl,
        ...(providerType === "webdav"
          ? { rootPath: "upload", authMethod: "username_password", tlsVerify: false, credential: { kind: "username_password", username: "u", password: "p" } }
          : { bucket: "stage5-bucket", region: "us-east-1", authMethod: "access_key", tlsVerify: false, credential: { kind: "access_key", accessKeyId: "AKIASTAGE5", secretAccessKey: "stage5-secret" } }),
        ...extra,
      });
      const cases: Array<[string, Record<string, unknown>]> = [
        ["WebDAV 云元数据", target("ssrf-webdav-meta", "webdav", "http://169.254.169.254/dav")],
        ["WebDAV 10/8", target("ssrf-webdav-10", "webdav", "http://10.0.0.5/dav")],
        ["WebDAV 192.168/16", target("ssrf-webdav-192", "webdav", "http://192.168.1.10/dav")],
        ["WebDAV ULA", target("ssrf-webdav-ula", "webdav", "https://[fd00::1]/dav")],
        ["WebDAV 链路本地", target("ssrf-webdav-ll", "webdav", "https://[fe80::1]/dav")],
        ["WebDAV IPv6 回环", target("ssrf-webdav-lo", "webdav", "https://[::1]/dav")],
        ["S3 172.16/12", target("ssrf-s3-172", "s3", "http://172.16.5.5:9000")],
        ["S3 ULA", target("ssrf-s3-ula", "s3", "http://[fc00::1]:9000")],
      ];
      for (const [label, body] of cases) {
        const result = await adminJson(owner, "/api/v1/admin/backups/destinations", {
          method: "POST",
          body: JSON.stringify(body),
        });
        log(`SSRF 备份目标 ${label}`, result.status, String(result.json.code));
        expect(result.status, label).toBe(400);
        expect(result.json.code, label).toBe("INVALID_REQUEST");
        const fieldErrors = (result.json.details as { fieldErrors?: Record<string, string> } | undefined)?.fieldErrors;
        expect(fieldErrors?.endpointUrl, label).toContain("内网");
      }
      expect(await prisma.backup_storage_destinations.count()).toBe(before);

      // 更新：已存在的合法目标不能被改成内网地址，且旧值保持不变。
      const created = await adminJson<{ id: string; endpointUrl: string }>(owner, "/api/v1/admin/backups/destinations", {
        method: "POST",
        body: JSON.stringify(target(`ssrf-patch-base-${runSuffix}`, "webdav", `http://127.0.0.1:${fixture.port}/dav`)),
      });
      expect(created.status).toBe(201);
      const destinationId = created.json.data!.id;
      const patched = await adminJson(owner, `/api/v1/admin/backups/destinations/${destinationId}`, {
        method: "PATCH",
        body: JSON.stringify({ endpointUrl: "http://169.254.169.254/dav", tlsVerify: false }),
      });
      log("SSRF 备份目标 PATCH", patched.status, String(patched.json.code));
      expect(patched.status).toBe(400);
      expect(patched.json.code).toBe("INVALID_REQUEST");
      const stored = await prisma.backup_storage_destinations.findUniqueOrThrow({ where: { id: destinationId } });
      expect(stored.endpoint_url).toBe(`http://127.0.0.1:${fixture.port}/dav`);
    });
  });

  describe("路径穿越与探针边界", () => {
    const base = () => ({
      providerType: "webdav" as const,
      endpointUrl: `http://127.0.0.1:${fixture.port}/dav`,
      authMethod: "username_password" as const,
      tlsVerify: false,
      credential: { kind: "username_password" as const, username: "u", password: "p" },
    });

    it("root_path / remote_prefix 含 .. 或编码穿越时拒绝", async () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["root_path ..", { name: "traversal-root-1", rootPath: "../escape" }, "rootPath"],
        ["root_path ../../etc", { name: "traversal-root-2", rootPath: "../../etc" }, "rootPath"],
        ["root_path 编码穿越", { name: "traversal-root-3", rootPath: "a/%2e%2e/b" }, "rootPath"],
        ["remote_prefix ..", { name: "traversal-prefix-1", remotePrefix: "../nightly" }, "remotePrefix"],
        ["remote_prefix ../../etc", { name: "traversal-prefix-2", remotePrefix: "../../etc" }, "remotePrefix"],
        ["remote_prefix 编码穿越", { name: "traversal-prefix-3", remotePrefix: "a/%2e%2e/b" }, "remotePrefix"],
      ];
      for (const [label, extra, field] of cases) {
        const result = await adminJson(owner, "/api/v1/admin/backups/destinations", {
          method: "POST",
          body: JSON.stringify({ ...base(), ...extra }),
        });
        log(`路径穿越 ${label}`, result.status, String(result.json.code));
        expect(result.status, label).toBe(400);
        const fieldErrors = (result.json.details as { fieldErrors?: Record<string, string> } | undefined)?.fieldErrors;
        expect(fieldErrors?.[field], label).toContain("..");
      }
    });

    it("绝对 root_path 落到目标根内，绝对 remote_prefix 被归一化为相对路径", async () => {
      const absoluteRoot = await adminJson<{ id: string; rootPath: string }>(owner, "/api/v1/admin/backups/destinations", {
        method: "POST",
        body: JSON.stringify({ ...base(), name: `absolute-root-${runSuffix}`, rootPath: "/absolute/prefix" }),
      });
      expect(absoluteRoot.status).toBe(201);
      expect(absoluteRoot.json.data!.rootPath).toBe("/absolute/prefix");

      fixture.paths.length = 0;
      fixture.bodies.clear();
      const tested = await adminJson<{ passed: boolean }>(
        owner,
        `/api/v1/admin/backups/destinations/${absoluteRoot.json.data!.id}/test`,
        { method: "POST", body: JSON.stringify({}) },
      );
      expect(tested.status).toBe(200);
      expect(tested.json.data!.passed).toBe(true);
      expect(fixture.paths.length).toBeGreaterThan(0);
      for (const path of fixture.paths) {
        expect(path.startsWith("/dav/absolute/prefix/"), path).toBe(true);
      }

      const absolutePrefix = await adminJson<{ remotePrefix: string }>(owner, "/api/v1/admin/backups/destinations", {
        method: "POST",
        body: JSON.stringify({ ...base(), name: `absolute-prefix-${runSuffix}`, rootPath: "upload", remotePrefix: "/nightly/" }),
      });
      expect(absolutePrefix.status).toBe(201);
      expect(absolutePrefix.json.data!.remotePrefix).toBe("nightly");
    });

    it("连接测试的探针文件不写出 root_path，且路径里没有 ..", async () => {
      const created = await adminJson<{ id: string }>(owner, "/api/v1/admin/backups/destinations", {
        method: "POST",
        body: JSON.stringify({ ...base(), name: `probe-contained-${runSuffix}`, rootPath: "team/upload", remotePrefix: "nightly" }),
      });
      expect(created.status).toBe(201);
      fixture.paths.length = 0;
      const tested = await adminJson(owner, `/api/v1/admin/backups/destinations/${created.json.data!.id}/test`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      log("WebDAV 探针测试", tested.status, String(tested.json.code));
      expect(tested.status).toBe(200);
      expect(fixture.paths.length).toBeGreaterThan(0);
      for (const path of fixture.paths) {
        expect(path.startsWith("/dav/team/upload/"), path).toBe(true);
        expect(path.includes(".."), path).toBe(false);
      }
      expect(fixture.paths.some((path) => path.includes("_probe/ziming-connectivity-probe.txt"))).toBe(true);
    });
  });

  describe("Webhook 投递不跟随重定向", () => {
    it("302 指向内网/同源地址时只记录 3xx，不访问跳转目标", async () => {
      const created = await adminJson<{ id: string }>(owner, "/api/v1/admin/webhooks", {
        method: "POST",
        body: JSON.stringify({
          productId: ctxA.productId,
          url: `http://127.0.0.1:${redirectFixture.port}/redirect`,
          eventTypes: ["license.activated"],
        }),
      });
      expect(created.status).toBe(201);
      redirectFixture.internalHits = 0;
      const tested = await adminJson<{ outcome: string; responseStatus: number }>(
        owner,
        `/api/v1/admin/webhooks/${created.json.data!.id}/test`,
        { method: "POST", body: JSON.stringify({}) },
      );
      log("Webhook 302 投递", tested.status, String(tested.json.code));
      expect(tested.status).toBe(200);
      expect(tested.json.data!.responseStatus).toBe(302);
      expect(tested.json.data!.outcome).not.toBe("succeeded");
      expect(redirectFixture.internalHits).toBe(0);
    });
  });

  async function snapshotTenantB() {
    const [org, license, customer, product, device, activation, webhook, destination, job] = await Promise.all([
      prisma.organizations.findUniqueOrThrow({ where: { id: tenantB.organizationId } }),
      prisma.licenses.findUniqueOrThrow({ where: { id: tenantB.licenseId } }),
      prisma.customers.findUniqueOrThrow({ where: { id: tenantB.customerId } }),
      prisma.products.findUniqueOrThrow({ where: { id: tenantB.productId } }),
      prisma.devices.findUniqueOrThrow({ where: { id: tenantB.deviceId } }),
      prisma.activations.findUniqueOrThrow({ where: { id: tenantB.activationId } }),
      prisma.webhook_endpoints.findUniqueOrThrow({ where: { id: tenantB.webhookId } }),
      prisma.backup_storage_destinations.findUniqueOrThrow({ where: { id: tenantB.destinationId } }),
      prisma.backup_jobs.findUniqueOrThrow({ where: { id: tenantB.jobId } }),
    ]);
    return {
      orgName: org.name,
      licenseStatus: license.admin_status,
      licenseNotes: license.notes,
      customerName: customer.name,
      productName: product.name,
      deviceStatus: device.status,
      activationStatus: activation.status,
      webhookUrl: webhook.url,
      webhookStatus: webhook.status,
      destinationName: destination.name,
      destinationEndpoint: destination.endpoint_url,
      destinationTestStatus: destination.last_test_status,
      jobStatus: job.status,
    };
  }

  async function snapshotTenantA() {
    const org = await prisma.organizations.findFirstOrThrow({ where: { slug: "xinglan-software" } });
    const [licenses, members, roles, credentials, signingKeys, webhooks, jobs, audits] = await Promise.all([
      prisma.licenses.count({ where: { organization_id: org.id } }),
      prisma.organization_memberships.count({ where: { organization_id: org.id } }),
      prisma.roles.count({ where: { organization_id: org.id } }),
      prisma.product_credentials.count({ where: { organization_id: org.id } }),
      prisma.signing_keys.count({ where: { organization_id: org.id } }),
      prisma.webhook_endpoints.count({ where: { organization_id: org.id } }),
      prisma.backup_jobs.count({ where: { organization_id: org.id } }),
      // 阶段6：403/404 探测会按设计写入安全告警审计；快照只统计业务审计，
      // 安全告警的增量由告警用例单独断言，不能当作越权写成功。
      prisma.audit_logs.count({
        where: { organization_id: org.id, action: { notIn: ["authz.probing", "auth.login_bruteforce"] } },
      }),
    ]);
    return {
      organizationId: org.id,
      orgName: org.name,
      settings: org.settings,
      licenses,
      members,
      roles,
      credentials,
      signingKeys,
      webhooks,
      jobs,
      audits,
    };
  }

  // userAId 仅用于确认基线会话属于 A 组织（避免误用 B 的会话）。
  it("测试夹具自检：A 会话与 B 会话指向不同组织", async () => {
    const meA = await adminJson<{ organization: { id: string } }>(owner, "/api/v1/admin/me");
    const meB = await adminJson<{ organization: { id: string } }>(tenantBAdmin, "/api/v1/admin/me");
    expect(meA.json.data!.organization.id).not.toBe(meB.json.data!.organization.id);
    expect(meA.json.data!.organization.id).not.toBe(tenantB.organizationId);
    expect(userAId).toBeTruthy();
  });
});
