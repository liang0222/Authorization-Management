/**
 * 授权管理 SaaS 的项目适配器（规格 Layer 2）。
 *
 * 这是唯一一个「知道本项目长什么样」的模块：表名、密码哈希算法、角色预设、
 * 签名密钥目录。通用核心不 import 这里任何东西，只通过 InstallerAdapter 契约调用。
 *
 * 复用而不是重写（规格 §十一「如果当前项目有现成的管理员创建功能，应优先复用」）：
 * - 密码哈希用 src/lib/auth/password.ts 的 hashPassword（scrypt，与登录校验同源）
 * - 权限码与角色预设用 src/lib/domain/permissions.ts
 * - 迁移用项目自带的 Prisma Migrate
 *
 * 数据库连接：**不使用 src/lib/db.ts 的单例**。那个单例在模块加载时读进程环境，
 * 而安装期的连接串来自表单。这里按表单的 URL 现建 PrismaClient，用完 disconnect。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../../host/prisma-client";
import type {
  AdapterContext,
  AdminResult,
  CheckItem,
  DatabaseInspection,
  DatabaseTestResult,
  DetectResult,
  HealthResult,
  InitializeResult,
  InstallerAdapter,
  InstallerConfigInput,
  InstallRecord,
  MigrationResult,
  ProjectManifest,
  ValidationIssue,
  ValidationResult,
} from "../../contract";
import { describeTarget, inspectDatabase, parseDatabaseUrl, testDatabaseConnection } from "../../database";
import { runPrismaMigrate } from "../../migrations";
import { hashPassword, passwordPolicyIssues } from "../../../../host/password";
import { ALL_PERMISSION_CODES, PERMISSIONS, ROLE_PRESETS } from "../../../../host/permissions";

/** 权限码 → 中文说明，直接取自项目自己的权限表，不另维护一份文案。 */
const PERMISSION_DESCRIPTIONS = new Map(PERMISSIONS.map((p) => [p.code, p.description]));
import { licensingSaasManifest, LICENSING_SAAS_PROJECT_ID } from "./manifest";
import { resolveDatabaseUrl } from "../../orchestrator";

/** Ed25519 SPKI DER 固定前缀（与 signing-keys 路由保持一致）。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function formatKid(date: Date): string {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = createHash("sha256")
    .update(`${date.getTime()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
  return `sk_${ymd}_${suffix}`;
}

function fingerprint(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

async function withPrisma<T>(databaseUrl: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const db = new PrismaClient({ adapter });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

function toIssues(input: InstallerConfigInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const email = String(input.admin.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    issues.push({ field: "email", message: "邮箱格式不正确" });
  }

  const password = String(input.admin.password ?? "");
  if (password) {
    for (const message of passwordPolicyIssues(password)) {
      issues.push({ field: "password", message });
    }
  }

  const slug = String(input.system.organizationSlug ?? "").trim();
  if (slug && !/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
    issues.push({ field: "organizationSlug", message: "只能是小写字母、数字与连字符，2-80 位" });
  }

  const baseUrl = String(input.system.appBaseUrl ?? "").trim();
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        issues.push({ field: "appBaseUrl", message: "只支持 http 或 https" });
      }
    } catch {
      issues.push({ field: "appBaseUrl", message: "不是合法 URL" });
    }
  }

  try {
    resolveDatabaseUrl(input);
  } catch (error) {
    issues.push({ field: "databaseUrl", message: (error as Error).message });
  }

  return issues;
}

export class LicensingSaasAdapter implements InstallerAdapter {
  readonly id = LICENSING_SAAS_PROJECT_ID;

  constructor(private readonly projectDir: string) {}

  /** 1. 识别项目：看 package.json 的 name 与 prisma/schema.prisma 是否存在。 */
  async detect(): Promise<DetectResult> {
    const evidence: string[] = [];
    let detected = false;
    let projectVersion: string | undefined;

    try {
      const pkgPath = join(this.projectDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name) evidence.push(`package.json name=${pkg.name}`);
        projectVersion = pkg.version;
        if (pkg.name && /licensing|授权/i.test(pkg.name)) detected = true;
      }
    } catch {
      /* 读不到不算失败，继续用其他证据 */
    }

    if (existsSync(join(this.projectDir, "prisma", "schema.prisma"))) {
      evidence.push("存在 prisma/schema.prisma");
      detected = true;
    }
    if (existsSync(join(this.projectDir, "src", "lib", "domain", "permissions.ts"))) {
      evidence.push("存在权限模块");
      detected = true;
    }

    return { detected, evidence, projectVersion };
  }

  async getManifest(): Promise<ProjectManifest> {
    return licensingSaasManifest;
  }

  /** 8. 项目侧校验（密码强度、slug、URL、连接串形态）。 */
  async validateConfig(input: InstallerConfigInput): Promise<ValidationResult> {
    const issues = toIssues(input);
    return { ok: issues.length === 0, issues };
  }

  /** 9. 测试数据库连接。 */
  async testDatabase(input: InstallerConfigInput): Promise<DatabaseTestResult> {
    return testDatabaseConnection(input);
  }

  /** 10. 检查初始化条件。 */
  async inspectDatabase(input: InstallerConfigInput): Promise<DatabaseInspection> {
    return inspectDatabase(input);
  }

  /** 11. 迁移：委托给项目自带的 Prisma Migrate。 */
  async runMigrations(ctx: AdapterContext): Promise<MigrationResult> {
    const inspection = await inspectDatabase(ctx.input).catch(() => null);
    const outcome = await runPrismaMigrate({
      projectDir: this.projectDir,
      databaseUrl: ctx.databaseUrl,
      hasExistingTables: (inspection?.tableCount ?? 0) > 0,
      dataDir: ctx.dataDir,
    });
    ctx.log(outcome.message, { applied: outcome.applied.length, backup: outcome.backup.status });
    return {
      ok: outcome.ok,
      applied: outcome.applied,
      alreadyApplied: outcome.alreadyApplied,
      backup: outcome.backup,
      message: outcome.message,
    };
  }

  /**
   * 12. 初始化：权限码 → 组织 → 4 个系统角色 → 角色权限 → 首把签名密钥。
   * 全部幂等：重复执行只会得到 skipped。
   */
  async initialize(ctx: AdapterContext): Promise<InitializeResult> {
    const tasks: InitializeResult["tasks"] = [];
    const system = ctx.input.system;
    const organizationName = String(system.organizationName ?? "我的组织").trim() || "我的组织";
    const organizationSlug = String(system.organizationSlug ?? "default").trim() || "default";
    const timezone = String(system.timezone ?? "UTC").trim() || "UTC";
    const keyDir = String(system.signingKeyDir ?? ".keys-prod").trim() || ".keys-prod";

    try {
      await withPrisma(ctx.databaseUrl, async (db) => {
        /*
         * 权限码：按「缺什么补什么」写，不能按「表里有没有行」判断。
         *
         * 曾经的写法是 `if (count === 0)` 才灌 35 个码。但项目自带的迁移
         * 20261102150000_backup_permissions 会在建表时就插入 3 个 backup:* 权限码，
         * 于是空库迁移完 permissions 已有 3 行 → 判定「已存在」→ 35 个码一个都没写
         * → 紧接着的 role_permissions 引用不存在的 permission_code → 外键约束失败。
         * 这条是 Phase 7 真跑「全新安装」时暴露的，不是推测。
         */
        const existingCodes = new Set((await db.permissions.findMany({ select: { code: true } })).map((p) => p.code));
        const missingCodes = ALL_PERMISSION_CODES.filter((code) => !existingCodes.has(code));
        if (missingCodes.length > 0) {
          await db.permissions.createMany({
            data: missingCodes.map((code) => ({ code, description: PERMISSION_DESCRIPTIONS.get(code) ?? code })),
            skipDuplicates: true,
          });
          tasks.push({
            id: "permissions",
            status: "created",
            message: `补写 ${missingCodes.length} 个权限码（原有 ${existingCodes.size} 个）`,
          });
        } else {
          tasks.push({
            id: "permissions",
            status: "skipped",
            message: `权限码已齐全（${existingCodes.size} 个），跳过`,
          });
        }

        /* 组织 */
        let organization = await db.organizations.findFirst({ where: { slug: organizationSlug } });
        if (!organization) {
          organization = await db.organizations.create({
            data: {
              name: organizationName,
              slug: organizationSlug,
              timezone,
              settings: {
                apiRequestLogRetentionDays: 30,
                auditLogRetentionDays: 180,
                defaultSessionTtlHours: 8,
                webhookMaxRetries: 6,
                allowPublicCredentialRotation: true,
              },
            },
          });
          tasks.push({
            id: "organization",
            status: "created",
            message: `创建组织 ${organization.name}（${organization.slug}）`,
          });
        } else {
          tasks.push({
            id: "organization",
            status: "skipped",
            message: `组织 ${organization.name} 已存在，沿用`,
          });
        }

        /* 角色与角色权限 */
        for (const preset of ROLE_PRESETS) {
          let role = await db.roles.findFirst({
            where: { organization_id: organization.id, code: preset.code },
          });
          if (!role) {
            role = await db.roles.create({
              data: {
                organization_id: organization.id,
                code: preset.code,
                name: preset.name,
                is_system: true,
              },
            });
            tasks.push({
              id: `role:${preset.code}`,
              status: "created",
              message: `创建角色 ${preset.name}（${preset.permissions.length} 项权限）`,
            });
          } else {
            tasks.push({ id: `role:${preset.code}`, status: "skipped", message: `角色 ${preset.name} 已存在` });
          }

          const have = await db.role_permissions.count({ where: { role_id: role.id } });
          if (have < preset.permissions.length) {
            await db.role_permissions.createMany({
              data: preset.permissions.map((code) => ({ role_id: role!.id, permission_code: code })),
              skipDuplicates: true,
            });
            tasks.push({
              id: `role_permissions:${preset.code}`,
              status: "created",
              message: `补齐 ${preset.name} 的权限映射`,
            });
          }
        }

        /* 首把签名密钥：没有 active 密钥时生成，否则跳过 */
        const active = await db.signing_keys.count({
          where: { organization_id: organization.id, status: "active" },
        });
        if (active === 0) {
          const now = new Date();
          const kid = formatKid(now);
          const { publicKey, privateKey } = generateKeyPairSync("ed25519");
          const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
          if (!spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
            throw new Error("Ed25519 公钥导出格式异常");
          }
          const pem = privateKey.export({ format: "pem", type: "pkcs8" });
          const absDir = resolve(this.projectDir, keyDir);
          mkdirSync(absDir, { recursive: true, mode: 0o700 });
          chmodSync(absDir, 0o700);
          const fileName = `${kid}.pem`;
          writeFileSync(join(absDir, fileName), pem, { mode: 0o600, flag: "wx" });
          chmodSync(join(absDir, fileName), 0o600);

          await db.signing_keys.create({
            data: {
              organization_id: organization.id,
              product_id: null,
              kid,
              algorithm: "EdDSA",
              public_key: Uint8Array.from(spki),
              private_key_ref: fileName,
              status: "active",
              not_before: now,
              not_after: null,
            },
          });
          tasks.push({
            id: "signing-key",
            status: "created",
            message: `生成签名密钥 ${kid}（公钥指纹 ${fingerprint(spki)}）`,
          });
        } else {
          tasks.push({ id: "signing-key", status: "skipped", message: `已有 ${active} 把可用签名密钥` });
        }
      });

      return {
        ok: true,
        tasks,
        message: `初始化完成：新建 ${tasks.filter((t) => t.status === "created").length} 项，跳过 ${
          tasks.filter((t) => t.status === "skipped").length
        } 项`,
      };
    } catch (error) {
      const message = (error as Error).message;
      tasks.push({ id: "initialize", status: "failed", message });
      return { ok: false, tasks, message: `初始化失败：${message}` };
    }
  }

  /**
   * 13. 创建管理员。绝不覆盖既有账号：邮箱已存在时直接报错，
   * 让恢复流程看到「已创建过」而不是悄悄改密码。
   */
  async createAdmin(ctx: AdapterContext): Promise<AdminResult> {
    const email = String(ctx.input.admin.email ?? "").trim().toLowerCase();
    const displayName = String(ctx.input.admin.displayName ?? "所有者").trim() || "所有者";
    const password = String(ctx.input.admin.password ?? "");
    const organizationSlug = String(ctx.input.system.organizationSlug ?? "default").trim() || "default";

    if (!email || !password) {
      return { ok: false, email, alreadyExisted: false, message: "管理员邮箱或密码为空" };
    }

    try {
      return await withPrisma(ctx.databaseUrl, async (db) => {
        const organization = await db.organizations.findFirst({ where: { slug: organizationSlug } });
        if (!organization) {
          return {
            ok: false,
            email,
            alreadyExisted: false,
            message: `组织 ${organizationSlug} 不存在，初始化步骤可能未完成`,
          };
        }

        const existing = await db.users.findFirst({ where: { email } });
        if (existing) {
          const membership = await db.organization_memberships.findFirst({
            where: { organization_id: organization.id, user_id: existing.id },
          });
          return {
            ok: Boolean(membership),
            userId: existing.id,
            email,
            alreadyExisted: true,
            message: membership
              ? `管理员 ${email} 已存在并已加入组织，沿用（不修改密码）`
              : `用户 ${email} 已存在但未加入组织，请手工处理`,
          };
        }

        const ownerRole = await db.roles.findFirst({
          where: { organization_id: organization.id, code: "owner" },
        });
        if (!ownerRole) {
          return { ok: false, email, alreadyExisted: false, message: "owner 角色缺失，初始化步骤可能未完成" };
        }

        const passwordHash = await hashPassword(password);
        const user = await db.users.create({
          data: { email, password_hash: passwordHash, display_name: displayName, status: "active" },
        });
        await db.organization_memberships.create({
          data: {
            organization_id: organization.id,
            user_id: user.id,
            role_id: ownerRole.id,
            status: "active",
          },
        });

        return {
          ok: true,
          userId: user.id,
          email,
          alreadyExisted: false,
          message: `已创建管理员 ${email} 并授予所有者角色`,
        };
      });
    } catch (error) {
      return {
        ok: false,
        email,
        alreadyExisted: false,
        message: `创建管理员失败：${(error as Error).message}`,
      };
    }
  }

  /** 16. 最终健康检查：库能查、组织在、管理员在、签名私钥可读。 */
  async healthCheck(ctx: AdapterContext): Promise<HealthResult> {
    const checks: CheckItem[] = [];
    const keyDir = String(ctx.input.system.signingKeyDir ?? ".keys-prod").trim() || ".keys-prod";
    const organizationSlug = String(ctx.input.system.organizationSlug ?? "default").trim() || "default";

    try {
      await withPrisma(ctx.databaseUrl, async (db) => {
        await db.$queryRaw`select 1`;
        checks.push({ id: "db", title: "数据库连通", status: "ok", detail: describeTarget(parseDatabaseUrl(ctx.databaseUrl)) });

        const organization = await db.organizations.findFirst({ where: { slug: organizationSlug } });
        checks.push(
          organization
            ? { id: "org", title: "组织记录", status: "ok", detail: `${organization.name}（${organization.slug}）` }
            : { id: "org", title: "组织记录", status: "fail", detail: `未找到组织 ${organizationSlug}` },
        );

        if (organization) {
          const members = await db.organization_memberships.count({
            where: { organization_id: organization.id, status: "active" },
          });
          checks.push(
            members > 0
              ? { id: "admin", title: "管理员账号", status: "ok", detail: `${members} 名在册成员` }
              : { id: "admin", title: "管理员账号", status: "fail", detail: "组织下没有任何成员" },
          );

          const keys = await db.signing_keys.findMany({
            where: { organization_id: organization.id, status: "active" },
            select: { kid: true, private_key_ref: true },
            orderBy: { created_at: "desc" },
            take: 1,
          });
          const key = keys[0];
          if (!key) {
            checks.push({ id: "signing", title: "签名密钥", status: "fail", detail: "没有 active 状态的签名密钥" });
          } else {
            const keyPath = resolve(this.projectDir, keyDir, key.private_key_ref);
            const readable = existsSync(keyPath);
            checks.push(
              readable
                ? { id: "signing", title: "签名密钥", status: "ok", detail: `${key.kid} 私钥可读` }
                : {
                    id: "signing",
                    title: "签名密钥",
                    status: "fail",
                    detail: `${key.kid} 私钥文件缺失：${key.private_key_ref}`,
                    hint: "运行 npx tsx scripts/repair-signing-keys.mts --apply 补齐",
                  },
            );
          }
        }
      });
    } catch (error) {
      checks.push({ id: "db", title: "数据库连通", status: "fail", detail: (error as Error).message });
    }

    const failed = checks.filter((c) => c.status === "fail");
    return {
      ok: failed.length === 0,
      checks,
      message:
        failed.length === 0
          ? `健康检查通过（${checks.length} 项）`
          : `健康检查未通过：${failed.map((c) => `${c.title}（${c.detail}）`).join("；")}`,
    };
  }

  /**
   * 把安装记录写进本项目自己的库。幂等：project_id 有唯一约束，
   * 重复安装尝试只会更新同一行（恢复场景会重放这一步）。
   *
   * 阶段 3 起改用原生 SQL：`installer_records` 已从宿主的 Prisma schema 里移除
   * （表还在、数据保留，归属本包），所以 `db.installer_records` 这个模型句柄不存在了。
   * 表结构见 `packages/universal-installer/database/installer_records.sql`。
   */
  async recordInstall(ctx: AdapterContext, record: InstallRecord): Promise<void> {
    const detail = JSON.stringify(record.detail ?? {});
    await withPrisma(ctx.databaseUrl, async (db) => {
      await db.$executeRaw`
        INSERT INTO installer_records (
          project_id, project_version, installer_version, adapter,
          manifest_sha256, installed_by, attempt_id, detail
        ) VALUES (
          ${record.projectId}, ${record.projectVersion}, ${record.installerVersion}, ${record.adapter},
          ${record.manifestSha256}, ${record.installedBy ?? null}, ${record.attemptId}, ${detail}::jsonb
        )
        ON CONFLICT (project_id) DO UPDATE SET
          project_version   = EXCLUDED.project_version,
          installer_version = EXCLUDED.installer_version,
          adapter           = EXCLUDED.adapter,
          manifest_sha256   = EXCLUDED.manifest_sha256,
          installed_by      = EXCLUDED.installed_by,
          attempt_id        = EXCLUDED.attempt_id,
          detail            = EXCLUDED.detail,
          installed_at      = now()
      `;
    });
  }
}
