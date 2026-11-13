/**
 * 本地开发种子数据。
 *
 * 目标：让管理后台每个页面都有真实、可解释的业务数据（不是随机噪声）：
 * 4 条产品线（桌面 EXE / 浏览器插件 / 小程序 / 服务端网关）、套餐、
 * 客户、各状态授权、设备激活、验证日志、审计日志、Webhook 投递。
 *
 * 运行：npm run db:seed
 *
 * 正式部署首选干净首启模式（不灌演示业务数据）：
 *   SEED_MODE=core SEED_CORE_ADMIN_PASSWORD=<强口令> npm run db:seed
 * 只建组织、一个真实管理员、签名密钥与产品/套餐骨架；演示账号、客户、授权、
 * 激活、Webhook 与日志一律不建。管理员邮箱默认 admin@zming.de、组织名默认
 * 子铭科技有限公司（均可经环境变量覆盖）；口令不设默认值——它是生产管理员
 * 口令，写进仓库等于公开，只能部署时经环境变量给出。
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword, passwordPolicyIssues } from "../src/lib/auth/password";
import { DEMO_DISPLAY_NAMES, DEMO_EMAIL_DOMAIN } from "../src/lib/demo-accounts";
import { addDuration } from "../src/lib/domain/period";
import { ALL_PERMISSION_CODES, ROLE_PRESETS } from "../src/lib/domain/permissions";
import { seedGuardDecision } from "../src/lib/seed-guard";

/**
 * 生产护栏：在**连库之前**判断。本文件会先 TRUNCATE 30 张业务表再灌演示数据，
 * 一旦在生产库上跑错，代价是全部业务数据。判定逻辑与文案在 src/lib/seed-guard.ts。
 */
const seedGuard = seedGuardDecision(process.env);
if (!seedGuard.allowed) {
  console.error(seedGuard.reason);
  process.exit(1);
}
if (seedGuard.warning) {
  console.warn(seedGuard.warning);
}

const DATABASE_URL =
  process.env.LICENSE_DB_URL ??
  "postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public";
const PEPPER = process.env.LICENSE_HMAC_PEPPER ?? "dev-only-license-hmac-pepper-please-change-in-production";
const SIGNING_KEY_DIR = process.env.SIGNING_KEY_DIR ?? ".keys";
/**
 * 凭证归属环境。生产库跑种子时是 `production`；
 * 沙箱库用 `SEED_CREDENTIAL_ENVIRONMENT=sandbox` 跑同一份种子，
 * 得到一套只属于沙箱的 client_id（规格 27.3「独立产品凭证」）。
 */
const CREDENTIAL_ENV = process.env.SEED_CREDENTIAL_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
/**
 * 沙箱用一套**独立**的 client_id：如果沙箱和现网共用同一个标识，
 * 一旦沙箱标识外泄，攻击者拿它打生产接口在逻辑上就「合法」了。
 * 生产保持原有取值，避免影响现网 SDK 示例与集成测试。
 */
const CLIENT_IDS =
  CREDENTIAL_ENV === "sandbox"
    ? {
        desktop: "pc_sandbox_desktop_4a91c7e3b2",
        miniapp: "cs_sandbox_miniapp_7b2e4d1a",
        gateway: "cs_sandbox_gateway_9f3c8a5d",
      }
    : {
        desktop: "pc_desktop_7d3c1a9b4e2f",
        miniapp: "cs_miniapp_5f8c2d1e6a",
        gateway: "cs_gateway_9a1b3c7d2e",
      };

/**
 * 种子模式：
 * - `full`（默认）：本地开发/演示用，灌全部演示数据（含演示账号与演示客户/授权）。
 * - `core`：正式部署的干净首启。只建组织、一个真实管理员、产品/套餐骨架与签名密钥，
 *   不建演示账号、演示客户、授权、激活、Webhook 与日志，生产启动闸门不会命中演示账号。
 * core 模式的管理员口令只能来自环境变量（不设默认值——写进仓库等于公开）；
 * 邮箱默认 `admin@zming.de`、组织名默认「子铭科技有限公司」，均可经环境变量覆盖。
 * 管理员身份不得命中演示账号标识（`@xinglan.dev` 域名或演示显示名，
 * 见 src/lib/demo-accounts.ts），命中直接拒绝执行。
 */
const SEED_MODE = process.env.SEED_MODE === "core" ? "core" : "full";
const CORE_ADMIN_EMAIL = (process.env.SEED_CORE_ADMIN_EMAIL?.trim() || "admin@zming.de").toLowerCase();
const CORE_ADMIN_PASSWORD = process.env.SEED_CORE_ADMIN_PASSWORD ?? "";
const CORE_ADMIN_NAME = (process.env.SEED_CORE_ADMIN_NAME ?? "").trim() || "Admin";
const CORE_ORG_NAME = (process.env.SEED_CORE_ORG_NAME ?? "").trim() || "子铭科技有限公司";
const CORE_ORG_SLUG = (process.env.SEED_CORE_ORG_SLUG ?? "").trim() || "ziming";

if (SEED_MODE === "core") {
  const problems: string[] = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(CORE_ADMIN_EMAIL)) {
    problems.push("SEED_CORE_ADMIN_EMAIL 不是合法邮箱");
  } else if (CORE_ADMIN_EMAIL.endsWith(`@${DEMO_EMAIL_DOMAIN}`)) {
    problems.push(`SEED_CORE_ADMIN_EMAIL 不得使用演示域名 @${DEMO_EMAIL_DOMAIN}`);
  }
  if (!CORE_ADMIN_PASSWORD) {
    problems.push("SEED_CORE_ADMIN_PASSWORD 未设置");
  } else {
    problems.push(...passwordPolicyIssues(CORE_ADMIN_PASSWORD).map((issue) => `SEED_CORE_ADMIN_PASSWORD ${issue}`));
  }
  if ((DEMO_DISPLAY_NAMES as readonly string[]).includes(CORE_ADMIN_NAME)) {
    problems.push("SEED_CORE_ADMIN_NAME 不得使用演示账号的显示名");
  }
  if (problems.length > 0) {
    console.error(`SEED_MODE=core 配置不合规，已拒绝执行：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (seedGuard.warning) {
    console.log("注意：当前为 SEED_MODE=core 干净首启，管理员口令来自 SEED_CORE_ADMIN_PASSWORD（非演示口令），上面的演示口令警告不适用。");
  }
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

const TIMEZONE = "Asia/Shanghai";
const DAY = 86_400_000;
const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);
const daysLater = (d: number) => new Date(now.getTime() + d * DAY);
const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

function licenseKey(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(30);
  let out = "";
  for (let i = 0; i < 30; i += 1) {
    if (i > 0 && i % 6 === 0) out += "-";
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function keyHash(key: string): Uint8Array<ArrayBuffer> {
  const digest = createHmac("sha256", PEPPER)
    .update(key.replace(/[^0-9A-Za-z]/g, "").toUpperCase())
    .digest();
  const copy = new Uint8Array(digest.byteLength);
  copy.set(digest);
  return copy;
}

async function main() {
  console.log("清理既有数据…");
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      activation_events, activation_refresh_tokens, offline_grants, activations, devices,
      license_renewals, license_features, plan_features, license_keys, licenses,
      idempotency_records, activation_challenges, api_request_logs, audit_logs,
      webhook_deliveries, webhook_endpoints, password_reset_tokens, admin_sessions,
      customer_identities, plans, customers, signing_keys, product_credentials,
      product_features, products, organization_memberships, role_permissions, roles,
      permissions, organizations, users
    RESTART IDENTITY CASCADE
  `);

  // ---------------------------------------------------------------- 组织与权限
  const organization = await prisma.organizations.create({
    data: {
      name: SEED_MODE === "core" ? CORE_ORG_NAME : "星岚软件",
      slug: SEED_MODE === "core" ? CORE_ORG_SLUG : "xinglan-software",
      timezone: TIMEZONE,
      settings: {
        apiRequestLogRetentionDays: 30,
        auditLogRetentionDays: 180,
        defaultSessionTtlHours: 8,
        webhookMaxRetries: 6,
        allowPublicCredentialRotation: true,
      },
    },
  });
  const organizationId = organization.id;

  await prisma.permissions.createMany({
    data: ALL_PERMISSION_CODES.map((code) => ({ code, description: code })),
  });

  const roleIds = new Map<string, string>();
  for (const preset of ROLE_PRESETS) {
    const role = await prisma.roles.create({
      data: {
        organization_id: organizationId,
        code: preset.code,
        name: preset.name,
        is_system: true,
      },
    });
    roleIds.set(preset.code, role.id);
    await prisma.role_permissions.createMany({
      data: preset.permissions.map((code) => ({ role_id: role.id, permission_code: code })),
    });
  }

  // core 模式只建一个真实管理员（身份来自环境变量）；ops/viewer 在 core 下不建账号，
  // 仅借用 owner 这一行让下方演示段的引用在类型上成立——演示段在 core 模式整体跳过。
  const password = await hashPassword(SEED_MODE === "core" ? CORE_ADMIN_PASSWORD : "License#2026");
  const owner = await prisma.users.create({
    data:
      SEED_MODE === "core"
        ? { email: CORE_ADMIN_EMAIL, password_hash: password, display_name: CORE_ADMIN_NAME }
        : {
            email: "owner@xinglan.dev",
            password_hash: password,
            display_name: "陈星岚",
            last_login_at: hoursAgo(2),
          },
  });
  const ops =
    SEED_MODE === "core"
      ? owner
      : await prisma.users.create({
          data: {
            email: "ops@xinglan.dev",
            password_hash: password,
            display_name: "林可",
            last_login_at: hoursAgo(20),
          },
        });
  const viewer =
    SEED_MODE === "core"
      ? owner
      : await prisma.users.create({
          data: {
            email: "audit@xinglan.dev",
            password_hash: password,
            display_name: "周睿（审计）",
            last_login_at: daysAgo(3),
          },
        });

  await prisma.organization_memberships.createMany({
    data:
      SEED_MODE === "core"
        ? [{ organization_id: organizationId, user_id: owner.id, role_id: roleIds.get("owner")! }]
        : [
            { organization_id: organizationId, user_id: owner.id, role_id: roleIds.get("owner")! },
            { organization_id: organizationId, user_id: ops.id, role_id: roleIds.get("operator")! },
            { organization_id: organizationId, user_id: viewer.id, role_id: roleIds.get("viewer")! },
          ],
  });

  // ---------------------------------------------------------------- 产品
  const productDefs = [
    {
      code: "fluxpanel-desktop",
      name: "FluxPanel 桌面版",
      productType: "desktop" as const,
      description: "面向运维工程师的隧道与端口转发桌面客户端，按安装实例绑定设备。",
      currentVersion: "2.0.7",
      platforms: ["windows", "macos", "linux"],
      features: [
        { code: "basic_export", name: "导出配置", valueType: "boolean", defaultValue: true },
        { code: "advanced_settings", name: "高级转发设置", valueType: "boolean", defaultValue: false },
        { code: "max_batch_size", name: "批量任务上限", valueType: "number", defaultValue: 100 },
        { code: "theme_pack", name: "主题包", valueType: "string", defaultValue: "classic" },
      ],
    },
    {
      code: "browser-assistant",
      name: "星岚浏览器助手",
      productType: "browser_extension" as const,
      description: "Chrome / Edge Manifest V3 插件，使用账号身份授权，按账号绑定。",
      currentVersion: "1.4.2",
      platforms: ["chrome", "edge"],
      features: [
        { code: "auto_fill", name: "表单自动填充", valueType: "boolean", defaultValue: true },
        { code: "batch_capture", name: "批量采集", valueType: "boolean", defaultValue: false },
        { code: "daily_quota", name: "每日采集额度", valueType: "number", defaultValue: 200 },
      ],
    },
    {
      code: "workorder-miniapp",
      name: "工单小程序",
      productType: "mini_program" as const,
      description: "微信小程序工单系统，通过业务后端校验授权，前端不持有任何服务端凭证。",
      currentVersion: "3.1.0",
      platforms: ["wechat"],
      features: [
        { code: "seat_limit", name: "坐席数", valueType: "number", defaultValue: 3 },
        { code: "sla_report", name: "SLA 报表", valueType: "boolean", defaultValue: false },
        { code: "custom_fields", name: "自定义字段", valueType: "boolean", defaultValue: true },
      ],
    },
    {
      code: "openapi-gateway",
      name: "OpenAPI 网关",
      productType: "server" as const,
      description: "服务端到服务端接入的私有网关，使用 confidential_server 凭证与 Ed25519 离线授权。",
      currentVersion: "1.9.6",
      platforms: ["linux"],
      features: [
        { code: "qps_limit", name: "QPS 上限", valueType: "number", defaultValue: 50 },
        { code: "audit_export", name: "审计导出", valueType: "boolean", defaultValue: true },
        { code: "multi_region", name: "多区域部署", valueType: "boolean", defaultValue: false },
      ],
    },
  ];

  const products: Array<{
    id: string;
    code: string;
    name: string;
    type: string;
    featureCodes: string[];
    features: Array<{ code: string; valueType: string; defaultValue: unknown }>;
  }> = [];

  for (const def of productDefs) {
    const product = await prisma.products.create({
      data: {
        organization_id: organizationId,
        code: def.code,
        name: def.name,
        description: def.description,
        product_type: def.productType,
        current_version: def.currentVersion,
        supported_platforms: def.platforms,
        heartbeat_interval_seconds: def.productType === "desktop" ? 900 : 600,
        access_token_ttl_seconds: 600,
      },
    });
    await prisma.product_features.createMany({
      data: def.features.map((feature) => ({
        organization_id: organizationId,
        product_id: product.id,
        code: feature.code,
        name: feature.name,
        value_type: feature.valueType,
        default_value: feature.defaultValue,
      })),
    });
    products.push({
      id: product.id,
      code: product.code,
      name: product.name,
      type: product.product_type,
      featureCodes: def.features.map((f) => f.code),
      features: def.features.map((f) => ({
        code: f.code,
        valueType: f.valueType,
        defaultValue: f.defaultValue,
      })),
    });
  }

  // ---------------------------------------------------------------- 凭证与签名密钥
  /**
   * 服务端凭证的公钥：`confidential_server` 用 private_key_jwt 认证，
   * 服务端只存公钥，私钥写到 `SIGNING_KEY_DIR/credentials/{client_id}.pem`（0600）。
   * 开发环境靠这份私钥跑示例与测试；生产环境由调用方自己生成密钥并只上传公钥。
   */
  mkdirSync(join(SIGNING_KEY_DIR, "credentials"), { recursive: true });
  const serverKeyPair = (clientId: string) => {
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(
      join(SIGNING_KEY_DIR, "credentials", `${clientId}.pem`),
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { mode: 0o600 },
    );
    return Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
  };

  const miniappPublicKey = serverKeyPair(CLIENT_IDS.miniapp);
  const gatewayPublicKey = serverKeyPair(CLIENT_IDS.gateway);

  await prisma.product_credentials.createMany({
    data: [
      {
        organization_id: organizationId,
        product_id: products[0].id,
        name: "桌面客户端公开标识",
        credential_type: "public_client",
        environment: CREDENTIAL_ENV,
        client_id: CLIENT_IDS.desktop,
        secret_hash: null,
        scopes: ["license:validate", "activation:create", "activation:heartbeat", "entitlements:read"],
        last_used_at: daysAgo(1),
      },
      {
        organization_id: organizationId,
        product_id: products[2].id,
        name: "小程序业务后端",
        credential_type: "confidential_server",
        environment: CREDENTIAL_ENV,
        client_id: CLIENT_IDS.miniapp,
        secret_hash: createHash("sha256").update("seed-secret-not-usable").digest(),
        scopes: ["server:check", "server:assign", "entitlements:read"],
        allowed_origins: ["https://api.demo.example"],
        last_used_at: hoursAgo(5),
        public_key: miniappPublicKey,
      },
      {
        organization_id: organizationId,
        product_id: products[3].id,
        name: "OpenAPI 网关机对机凭证",
        credential_type: "confidential_server",
        environment: CREDENTIAL_ENV,
        client_id: CLIENT_IDS.gateway,
        secret_hash: createHash("sha256").update("seed-secret-not-usable-2").digest(),
        scopes: ["server:check", "offline:grant", "entitlements:read"],
        allowed_origins: ["https://gateway.demo.example"],
        last_used_at: daysAgo(2),
        public_key: gatewayPublicKey,
      },
    ],
  });

  mkdirSync(SIGNING_KEY_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = `sk_20261102_${randomBytes(4).toString("hex")}`;
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(join(SIGNING_KEY_DIR, `${kid}.pem`), pem, { mode: 0o600 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  await prisma.signing_keys.create({
    data: {
      organization_id: organizationId,
      product_id: products[3].id,
      kid,
      public_key: spki,
      private_key_ref: `${kid}.pem`,
      status: "active",
      not_before: daysAgo(30),
      not_after: daysLater(335),
    },
  });
  await prisma.signing_keys.create({
    data: {
      organization_id: organizationId,
      product_id: products[3].id,
      kid: `sk_staged_${randomBytes(4).toString("hex")}`,
      public_key: publicKey.export({ type: "spki", format: "der" }),
      private_key_ref: `staged-${randomBytes(4).toString("hex")}.pem`,
      status: "staged",
      not_before: daysLater(7),
    },
  });

  // ---------------------------------------------------------------- 套餐
  // tier 决定「该档位解锁到第几个功能 / 数值功能乘以多少」，
  // 这样每个产品自己的功能码都能得到合理的默认值，而不是只有 FluxPanel 有。
  const planDefs: Array<{
    key: string;
    code: string;
    name: string;
    tier: number;
    duration: { unit: "day" | "month" | "lifetime"; value: number };
    maxDevices: number;
    maxActivationCount: number | null;
    maxSubjects: number | null;
    offline: boolean;
  }> = [
    {
      key: "trial7",
      tier: 0,
      code: "trial-7d",
      name: "7 天试用",
      duration: { unit: "day", value: 7 },
      maxDevices: 1,
      maxActivationCount: 2,
      maxSubjects: 1,
      offline: false,
    },
    {
      key: "basic30",
      tier: 1,
      code: "basic-30d",
      name: "30 天标准版",
      duration: { unit: "day", value: 30 },
      maxDevices: 2,
      maxActivationCount: 5,
      maxSubjects: 1,
      offline: false,
    },
    {
      key: "quarter",
      tier: 2,
      code: "pro-quarter",
      name: "季度专业版",
      duration: { unit: "month", value: 3 },
      maxDevices: 3,
      maxActivationCount: 8,
      maxSubjects: 3,
      offline: true,
    },
    {
      key: "year",
      tier: 3,
      code: "pro-year",
      name: "年度专业版",
      duration: { unit: "month", value: 12 },
      maxDevices: 5,
      maxActivationCount: 20,
      maxSubjects: 10,
      offline: true,
    },
    {
      key: "lifetime",
      tier: 4,
      code: "lifetime",
      name: "永久买断",
      duration: { unit: "lifetime", value: 0 },
      maxDevices: 2,
      maxActivationCount: null,
      maxSubjects: 1,
      offline: true,
    },
  ];

  const plansByProduct = new Map<string, Array<{ id: string; key: string; duration: { unit: "day" | "month" | "lifetime"; value: number }; maxDevices: number; maxActivationCount: number | null; maxSubjects: number | null; features: Record<string, unknown> }>>();

  for (const product of products) {
    const list: Array<{ id: string; key: string; duration: { unit: "day" | "month" | "lifetime"; value: number }; maxDevices: number; maxActivationCount: number | null; maxSubjects: number | null; features: Record<string, unknown> }> = [];
    for (const def of planDefs) {
      // 按「功能在列表里的位次」逐级解锁：布尔功能第 i 个在 tier >= i 时开启；
      // 数值功能按档位放大；字符串功能分基础/专业两档。这样每个产品都自带一套
      // 有意义的套餐差异，而不是空白。
      const features: Record<string, unknown> = {};
      product.features.forEach((feature, index) => {
        if (feature.valueType === "boolean") {
          features[feature.code] = def.tier >= index;
        } else if (feature.valueType === "number") {
          const base = Number(feature.defaultValue ?? 0) || 1;
          const multiplier = [0.25, 1, 2, 5, 10][def.tier] ?? 1;
          features[feature.code] = Math.max(1, Math.round(base * multiplier));
        } else if (feature.valueType === "string") {
          features[feature.code] = def.tier >= 2 ? "pro" : "classic";
        } else {
          features[feature.code] = feature.defaultValue;
        }
      });
      const plan = await prisma.plans.create({
        data: {
          organization_id: organizationId,
          product_id: product.id,
          code: def.code,
          name: def.name,
          duration_unit: def.duration.unit,
          duration_value: def.duration.value,
          start_policy: "on_first_activation",
          activation_deadline_days: def.duration.unit === "lifetime" ? null : 30,
          max_devices: def.maxDevices,
          max_activation_count: def.maxActivationCount,
          max_subjects: def.maxSubjects,
          refund_activation_on_release: false,
          offline_allowed: def.offline,
          offline_grace_seconds: def.offline ? 7 * 86_400 : 0,
          default_features: features as never,
        },
      });
      if (Object.keys(features).length > 0) {
        await prisma.plan_features.createMany({
          data: Object.entries(features).map(([code, value]) => ({
            plan_id: plan.id,
            product_id: product.id,
            organization_id: organizationId,
            feature_code: code,
            feature_value: value as never,
          })),
        });
      }
      list.push({ id: plan.id, key: def.key, duration: def.duration, maxDevices: def.maxDevices, maxActivationCount: def.maxActivationCount, maxSubjects: def.maxSubjects, features });
    }
    plansByProduct.set(product.id, list);
  }

  if (SEED_MODE === "core") {
    console.log(
      `干净首启完成：1 个组织（${CORE_ORG_NAME}）、1 个管理员（${CORE_ADMIN_EMAIL}）、${products.length} 个产品与套餐骨架、签名密钥已生成；未灌演示客户/授权/激活/Webhook/日志。`,
    );
    return;
  }

  // ---------------------------------------------------------------- 客户
  // 演示客户：全部为虚构主体（规格要求 seed 不得包含真实客户信息，
  // 这个文件要能公开分发）。company 与 email 域名的 .example 一致，
  // 都是 RFC 2606 保留域名，永远不会真的解析或收信。
  const customerDefs = [
    { name: "示例客户 01", company: "示例客户 01 有限公司", email: "ops@customer01.example", code: "C-1001" },
    { name: "示例客户 02", company: "示例客户 02 有限公司", email: "it@customer02.example", code: "C-1002" },
    { name: "示例客户 03", company: "示例客户 03 信息技术有限公司", email: "admin@customer03.example", code: "C-1003" },
    { name: "示例客户 04", company: "示例客户 04 设备有限公司", email: "ops@customer04.example", code: "C-1004" },
    { name: "示例客户 05", company: "示例客户 05 服务中心", email: "it@customer05.example", code: "C-1005" },
    { name: "示例客户 06", company: "示例客户 06 物流有限公司", email: "ops@customer06.example", code: "C-1006" },
    { name: "示例客户 07", company: "示例客户 07 软件园", email: "it@customer07.example", code: "C-1007" },
    { name: "示例客户 08", company: "示例客户 08 科技有限公司", email: "ops@customer08.example", code: "C-1008" },
    { name: "示例客户 09", company: "示例客户 09 电子有限公司", email: "it@customer09.example", code: "C-1009" },
    { name: "示例客户 10", company: "示例客户 10 平台", email: "ops@customer10.example", code: "C-1010" },
    { name: "示例客户 11", company: "示例客户 11 信息技术有限公司", email: "it@customer11.example", code: "C-1011" },
    { name: "示例客户 12", company: "示例客户 12 研究院", email: "ops@customer12.example", code: "C-1012" },
    { name: "个人开发者 · 示例甲", company: null, email: "dev-a@example.com", code: null },
    { name: "个人开发者 · 示例乙", company: null, email: "dev-b@example.com", code: null },
  ];

  const customers = [];
  for (const [index, def] of customerDefs.entries()) {
    customers.push(
      await prisma.customers.create({
        data: {
          organization_id: organizationId,
          name: def.name,
          company_name: def.company,
          email: def.email,
          customer_code: def.code,
          // 演示号码固定成 138-0000-00NN，不用随机数：随机出来的 11 位数字
          // 有可能正好是某个真人的手机号，而这个仓库和它的截图要能公开分发。
          phone: `1380000${String(index + 1).padStart(4, "0")}`,
          notes: def.company ? null : "个人开发者，按年订阅",
        },
      }),
    );
  }

  // ---------------------------------------------------------------- 授权
  // 到期时间不再写死，而是「起算时间 + 套餐周期」现算。
  // 否则列会显示「一年（12 个自然月）」却只有 320 天，看起来像程序算错了。
  const licenseStates: Array<{
    adminStatus: "pending" | "active" | "suspended" | "revoked" | "cancelled" | "draft";
    /** 起算时间在多少天前；null 表示尚未起算（首次激活起算）。 */
    startedDaysAgo: number | null;
    /** 未来起算（用于「未开始」状态），单位天。 */
    startsInDays?: number;
    activationDeadlineAt: Date | null;
    activated: boolean;
    planKey: string;
    count: number;
  }> = [
    // 生效中：起算 20 天前，一年套餐 → 还剩 ~345 天
    { adminStatus: "active", startedDaysAgo: 20, activationDeadlineAt: null, activated: true, planKey: "year", count: 16 },
    // 生效中且临近到期：起算 45 天前，一季度（3 个自然月）→ 约 45 天内到期
    { adminStatus: "active", startedDaysAgo: 45, activationDeadlineAt: null, activated: true, planKey: "quarter", count: 10 },
    // 生效中 30 天套餐：起算 5 天前 → 25 天后到期
    { adminStatus: "active", startedDaysAgo: 5, activationDeadlineAt: null, activated: true, planKey: "basic30", count: 8 },
    // 待激活（激活窗口仍开着 / 已过窗口）
    { adminStatus: "pending", startedDaysAgo: null, activationDeadlineAt: daysLater(12), activated: false, planKey: "basic30", count: 6 },
    { adminStatus: "pending", startedDaysAgo: null, activationDeadlineAt: daysAgo(3), activated: false, planKey: "trial7", count: 2 },
    // 已暂停
    { adminStatus: "suspended", startedDaysAgo: 60, activationDeadlineAt: null, activated: true, planKey: "year", count: 4 },
    // 已过期：起算 400 天前的一年套餐
    { adminStatus: "active", startedDaysAgo: 400, activationDeadlineAt: null, activated: true, planKey: "year", count: 5 },
    // 已撤销（终态）
    { adminStatus: "revoked", startedDaysAgo: 120, activationDeadlineAt: null, activated: true, planKey: "year", count: 3 },
    // 草稿：什么都不设
    { adminStatus: "draft", startedDaysAgo: null, activationDeadlineAt: null, activated: false, planKey: "trial7", count: 2 },
    // 未开始（fixed_start，10 天后才生效）
    { adminStatus: "active", startedDaysAgo: null, startsInDays: 10, activationDeadlineAt: null, activated: false, planKey: "quarter", count: 2 },
    // 已取消
    { adminStatus: "cancelled", startedDaysAgo: 30, activationDeadlineAt: null, activated: true, planKey: "year", count: 2 },
  ];

  let licenseIndex = 0;
  const createdLicenses: Array<{
    id: string;
    productId: string;
    customerId: string;
    planId: string;
    maxDevices: number;
    adminStatus: string;
    activated: boolean;
  }> = [];

  for (const product of products) {
    const productPlans = plansByProduct.get(product.id)!;
    for (const state of licenseStates) {
      for (let i = 0; i < state.count; i += 1) {
        const plan = productPlans.find((p) => p.key === state.planKey) ?? productPlans[0];
        const customer = customers[(licenseIndex * 3 + i) % customers.length];
        // 起算时间与到期时间成对现算，保证「周期」列与「开始 / 到期」列自洽。
        const startsAt =
          state.startedDaysAgo !== null
            ? daysAgo(state.startedDaysAgo)
            : state.startsInDays !== undefined
              ? daysLater(state.startsInDays)
              : null;
        const expiresAt = startsAt ? addDuration(startsAt, plan.duration, TIMEZONE) : null;
        const password = undefined;
        void password;
        const license = await prisma.licenses.create({
          data: {
            organization_id: organizationId,
            product_id: product.id,
            customer_id: customer.id,
            plan_id: plan.id,
            external_order_id: `ORD-${2026}-${String(1000 + licenseIndex)}`,
            admin_status: state.adminStatus,
            duration_unit: plan.duration.unit,
            duration_value: plan.duration.value,
            start_policy:
              startsAt && startsAt.getTime() > now.getTime() ? "fixed_start" : "on_first_activation",
            timezone: TIMEZONE,
            starts_at: startsAt,
            expires_at: expiresAt,
            activation_deadline_at: state.activationDeadlineAt,
            max_devices: plan.maxDevices,
            max_activation_count: plan.maxActivationCount,
            activation_count: state.activated ? 1 + (i % Math.min(3, plan.maxDevices)) : 0,
            max_subjects: plan.maxSubjects,
            offline_allowed: plan.key === "lifetime" || plan.key === "year",
            offline_grace_seconds: plan.key === "year" ? 7 * 86_400 : 0,
            feature_snapshot: plan.features as never,
            notes: i % 7 === 0 ? "由销售订单系统自动签发" : null,
            created_by: owner.id,
            created_at: daysAgo(60 - (licenseIndex % 50)),
          },
        });

        if (state.adminStatus !== "draft") {
          const plaintext = licenseKey();
          await prisma.license_keys.create({
            data: {
              organization_id: organizationId,
              license_id: license.id,
              key_prefix: plaintext.replace(/-/g, "").slice(0, 8),
              key_last4: plaintext.slice(-4),
              key_hash: keyHash(plaintext),
              hash_key_version: process.env.LICENSE_HMAC_PEPPER_VERSION ?? "v1",
              first_redeemed_at: state.activated ? daysAgo(20) : null,
            },
          });
        }

        if (state.activated) {
          const deviceCount = Math.min(1 + (i % plan.maxDevices), plan.maxDevices);
          for (let d = 0; d < deviceCount; d += 1) {
            const platform = product.type === "desktop" ? pick(["windows", "macos", "linux"]) : product.type === "browser_extension" ? pick(["chrome", "edge"]) : product.type === "mini_program" ? "wechat" : "linux";
            const device = await prisma.devices.create({
              data: {
                organization_id: organizationId,
                product_id: product.id,
                device_instance_id: `install_${randomBytes(6).toString("hex")}`,
                platform,
                device_name: platform === "windows" ? `DESKTOP-${randomBytes(2).toString("hex").toUpperCase()}` : `${platform}-node-${randomBytes(1).toString("hex")}`,
                public_key: randomBytes(32),
                public_key_thumbprint: createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 32),
                first_seen_at: daysAgo(30 - d),
                last_seen_at: hoursAgo(Math.floor(Math.random() * 60)),
              },
            });
            const activation = await prisma.activations.create({
              data: {
                organization_id: organizationId,
                product_id: product.id,
                license_id: license.id,
                device_id: device.id,
                status: "active",
                activated_at: daysAgo(25 - d),
                last_seen_at: hoursAgo(Math.floor(Math.random() * 30)),
                client_version: product.type === "desktop" ? "2.0.7" : "1.4.2",
                last_ip: `116.62.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
              },
            });
            await prisma.activation_events.create({
              data: {
                organization_id: organizationId,
                activation_id: activation.id,
                event_type: "activation.created",
                actor_type: "client",
                request_id: `req_seed_${randomBytes(4).toString("hex")}`,
                ip: `116.62.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
                details: { platform, client_version: "2.0.7" },
                // 摊到最近 14 天，让「近 7 天新增激活」这类窗口指标有真实分布
                created_at: daysAgo((d / 5) * 13 + Math.random() * 2),
              },
            });
          }
        }

        createdLicenses.push({
          id: license.id,
          productId: product.id,
          customerId: customer.id,
          planId: plan.id,
          maxDevices: plan.maxDevices,
          adminStatus: state.adminStatus,
          activated: state.activated,
        });
        licenseIndex += 1;
      }
    }
  }

  // 为部分已激活授权补充续费记录
  const renewable = createdLicenses.filter((l) => l.adminStatus === "active" && l.activated).slice(0, 12);
  for (const [index, license] of renewable.entries()) {
    const previous = daysAgo(30);
    const next = addDuration(previous, { unit: "month", value: 12 }, TIMEZONE);
    await prisma.license_renewals.create({
      data: {
        organization_id: organizationId,
        license_id: license.id,
        duration_unit: "month",
        duration_value: 12,
        previous_expires_at: previous,
        renewal_starts_at: previous,
        new_expires_at: next,
        renewal_mode: "append",
        external_payment_ref: `PAY-${2026}${String(2000 + index)}`,
        notes: index % 3 === 0 ? "客户提前续费一年" : null,
        created_by: ops.id,
        created_at: daysAgo(31),
      },
    });
  }

  // ---------------------------------------------------------------- 客户身份绑定
  /**
   * 客户身份绑定：`customer_identities.subject_hash` 存 sha256(subject_token)，
   * 库里没有明文 subject，所以示例与测试必须从「约定的 subject」反推哈希——
   * 这里约定的就是下面这几条 (`demo:customer:<code>` 之类)，写进 docs 与 SDK 示例。
   */
  const identitySubjects = customers.slice(0, 6).map((customer, index) => ({
    customer,
    provider: (["wechat_mini_program", "email", "google", "wechat_mini_program", "phone", "custom"] as const)[
      index % 6
    ],
    subject: `demo:${customer.customer_code ?? "dev"}:${index}`,
  }));

  for (const item of identitySubjects) {
    for (const product of products) {
      await prisma.customer_identities.create({
        data: {
          organization_id: organizationId,
          customer_id: item.customer.id,
          product_id: product.id,
          provider: item.provider,
          subject_hash: createHash("sha256").update(item.subject, "utf8").digest(),
          display_name: item.customer.name,
          status: "active",
          verified_at: daysAgo(10 + Math.floor(Math.random() * 20)),
        },
      });
    }
  }

  // ---------------------------------------------------------------- Webhook
  const hookHost = (label: string) => `https://hooks.demo.example/${label}`;
  const hooks = await Promise.all([
    prisma.webhook_endpoints.create({
      data: {
        organization_id: organizationId,
        product_id: products[1].id,
        url: hookHost("browser-assistant"),
        secret_hash: createHash("sha256").update("whsec_seed_1").digest(),
        event_types: ["license.activated", "license.expired", "entitlements.updated"],
      },
    }),
    prisma.webhook_endpoints.create({
      data: {
        organization_id: organizationId,
        product_id: products[2].id,
        url: hookHost("workorder"),
        secret_hash: createHash("sha256").update("whsec_seed_2").digest(),
        event_types: ["license.activated", "license.suspended", "activation.created"],
      },
    }),
    prisma.webhook_endpoints.create({
      data: {
        organization_id: organizationId,
        product_id: products[3].id,
        url: "http://localhost:8088/gateway-hook",
        secret_hash: createHash("sha256").update("whsec_seed_3").digest(),
        event_types: ["license.renewed", "offline.grant"],
        status: "disabled",
      },
    }),
  ]);

  const deliveryStatuses = ["succeeded", "succeeded", "succeeded", "failed", "dead", "pending"] as const;
  for (let i = 0; i < 18; i += 1) {
    const status = deliveryStatuses[i % deliveryStatuses.length];
    const endpoint = hooks[i % 2];
    await prisma.webhook_deliveries.create({
      data: {
        endpoint_id: endpoint.id,
        event_id: `evt_${randomBytes(6).toString("hex")}`,
        event_type: pick(["license.activated", "license.expired", "license.suspended", "activation.created"]),
        payload: { license_id: createdLicenses[i % createdLicenses.length].id, occurred_at: hoursAgo(i * 3).toISOString() },
        status,
        attempt_count: status === "dead" ? 6 : status === "failed" ? 2 : 1,
        next_attempt_at: status === "pending" ? hoursAgo(-1) : null,
        response_status: status === "succeeded" ? 200 : 500,
        last_error: status === "succeeded" ? null : "连接超时：443 (ETIMEDOUT)",
        created_at: hoursAgo(i * 3),
        delivered_at: status === "succeeded" ? hoursAgo(i * 3 - 0.01) : null,
      },
    });
  }

  // ---------------------------------------------------------------- 验证日志（api_request_logs）
  const routes = [
    { route: "/api/v1/activations", method: "POST" },
    { route: "/api/v1/activations/heartbeat", method: "POST" },
    { route: "/api/v1/activations/deactivate", method: "POST" },
    { route: "/api/v1/licenses/validate", method: "POST" },
    { route: "/api/v1/activations/{id}/entitlements", method: "GET" },
    { route: "/api/v1/activation-challenges", method: "POST" },
  ];
  // 错误码与 HTTP 状态码必须成对出现。
  // 早先的写法是「先从 409/410/422/423 里随机取状态，再从错误码数组里随机取码」，
  // 于是同一个 LICENSE_EXPIRED 会同时出现 409、410、422 —— 演示数据反过来演示了一个
  // 错误契约，还在验证日志与用量分析里让人误判成「服务端状态码不稳定」。
  const errorKinds = [
    { code: "LICENSE_INVALID", status: 422 },
    { code: "LICENSE_EXPIRED", status: 410 },
    { code: "LICENSE_SUSPENDED", status: 423 },
    { code: "DEVICE_LIMIT_EXCEEDED", status: 409 },
    { code: "ACTIVATION_LIMIT_REACHED", status: 409 },
    { code: "CLIENT_AUTH_FAILED", status: 401 },
    { code: "RATE_LIMITED", status: 429 },
  ];

  for (let i = 0; i < 260; i += 1) {
    const endpoint = routes[i % routes.length];
    const isError = Math.random() < 0.18;
    const kind = isError ? pick(errorKinds) : null;
    const status = kind ? kind.status : pick([200, 200, 200, 200, 201]);
    await prisma.api_request_logs.create({
      data: {
        organization_id: organizationId,
        product_id: products[i % products.length].id,
        request_id: `req_${randomBytes(8).toString("hex")}`,
        method: endpoint.method,
        route: endpoint.route,
        response_status: status,
        error_code: kind ? kind.code : null,
        latency_ms: 8 + Math.floor(Math.random() * 180),
        ip: `116.62.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
        // 铺满最近 14 天（336 小时），否则「近 14 天验证量」图表只用得上 6 天数据。
        created_at: hoursAgo((i / 259) * 335 + Math.random() * 0.6),
      },
    });
  }

  // ---------------------------------------------------------------- 审计日志
  const auditActions = [
    "license.issue",
    "license.renew",
    "license.suspend",
    "license.resume",
    "license.revoke",
    "activation.release",
    "activation.block",
    "product.update",
    "credential.create",
    "member.update_role",
    "settings.update",
    "auth.login",
  ];
  for (let i = 0; i < 46; i += 1) {
    const target = createdLicenses[i % createdLicenses.length];
    const action = auditActions[i % auditActions.length];
    await prisma.audit_logs.create({
      data: {
        organization_id: organizationId,
        actor_type: "admin",
        actor_id: i % 3 === 0 ? ops.id : owner.id,
        action,
        resource_type: action.startsWith("license") ? "license" : action.startsWith("activation") ? "activation" : action.startsWith("product") ? "product" : "system",
        resource_id: action.startsWith("license") || action.startsWith("activation") ? target.id : null,
        before_data: { admin_status: "active" },
        after_data: { admin_status: i % 4 === 0 ? "suspended" : "active" },
        request_id: `req_${randomBytes(6).toString("hex")}`,
        ip: "203.0.113.10",
        user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0",
        created_at: hoursAgo(i * 2),
      },
    });
  }

  console.log(
    `种子数据完成：1 个组织、${products.length} 个产品、${customers.length} 个客户、${createdLicenses.length} 份授权、3 个 Webhook 端点。`,
  );
  console.log("登录账号：owner@xinglan.dev / License#2026（所有者），ops@xinglan.dev（运营），audit@xinglan.dev（只读）；Webhook 回调地址用 hooks.demo.example（RFC 2606 保留域，不会真发出）");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
