# Phase 1 · 项目审计报告

> 审计对象：`授权管理平台`（`licensing-saas` v1.5.0，仓库根 `/root/授权saas`）
> 审计目的：在动任何代码之前，先弄清这个项目**已经有什么**、**缺什么**、**哪些地方碰不得**。
> 审计方法：读源码 + 读迁移 + 读运行中的库 + 读 systemd 单元。所有结论都附可复现命令。

---

## 1. 技术栈与运行形态

| 项 | 实测值 | 取证方式 |
| --- | --- | --- |
| 框架 | Next.js 16.4.3（App Router，`cacheComponents: true`） | `package.json`、`next.config.ts` |
| UI | React 19.3.0 + Tailwind + shadcn（`src/components/ui/` 29 个组件） | `ls src/components/ui` |
| ORM | Prisma 7.10.1 + `@prisma/adapter-pg` | `package.json` |
| 数据库 | PostgreSQL 16（容器 `licensing-pg`，`127.0.0.1:55432`） | `docker ps` |
| 运行时 | Node v26.13.0 / npm 11.20.0 | `node -v` |
| 部署 | systemd `licensing-saas.service` → `127.0.0.1:3100`；沙箱 `-sandbox` → `3101` | `systemctl cat` |
| 反向代理 | openresty（容器 `1Panel-openresty-91lk`，`--network host`） | `docker ps` |

规模：`src` 308 个文件、`prisma` 10 个、`scripts` 9 个、`tests` 24 个、`sdk-examples` 11 个、`docs` 17 个。
`src/app` 下 **48 个 `page.tsx`**、**78 个 `route.ts`**。

---

## 2. 现有的初始化能力（关键结论）

### 2.1 `src/app` 里没有任何安装/初始化入口

```bash
grep -rln "install\|setup" src/app | grep -v developers
# 无输出
```

也就是说：**今天要装一个全新实例，只能手工跑 `prisma migrate deploy` + `tsx prisma/seed.ts`。**

### 2.2 `prisma/seed.ts` 不能当初始化用

`main()` 第一句就是：

```ts
await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
```

它清空 31 张表，然后写入固定组织（`星岚软件` / `xinglan-software`）、固定 4 个角色、固定管理员 `owner@example.dev` / 固定演示口令。
**它是演示数据脚本，不是安装器。** 任何"复用 seed 做初始化"的方案都会在客户环境里把已有数据抹掉。

### 2.3 现有 API 都要求已登录

- `POST /api/v1/admin/members`（`src/app/api/v1/admin/members/route.ts:213` 有 `users.create`）
- `POST /api/v1/admin/roles`（`roles/route.ts:161` 有 `roles.create`）

两者都在 `requireSession()` 之后。**冷启动时没有会话，所以这些接口无法用于首次初始化。**

**结论：必须由 Adapter 实现管理员初始化。** 这正好是规格第 11 章预留的扩展点（"如果没有管理员初始化能力，再通过适配器补充"）。

---

## 3. 认证与密码

`src/lib/auth/password.ts`：

- `hashPassword(password): Promise<string>` → `scrypt$N$r$p$saltB64$hashB64`（N=16384, r=8, p=1，Node 内置 `scrypt`）
- `verifyPassword(hash, password): Promise<boolean>`
- `passwordPolicyIssues(password): string[]` → 长度 ≥10、必须含字母与数字

会话（`src/lib/auth/session.ts`）：`admin_sessions` 表只存 `token_hash` / `csrf_token_hash` 的 SHA-256；Cookie 为 `lic_session`（32B）+ `lic_csrf`（24B），TTL 8h。

**对安装器的约束**：创建管理员必须走 `hashPassword()`，不能自己拼哈希；密码强度必须用 `passwordPolicyIssues()` 校验，不能另写一套规则。

---

## 4. 数据模型（安装器需要写的表）

| 表 | 关键字段 | 安装器要不要写 |
| --- | --- | --- |
| `organizations` | `id uuid`, `name`, `slug unique`, `timezone`, `status`, `settings Json` | **要**（1 行） |
| `permissions` | `code varchar(120) PK`, `description` | **要**（35 行，按缺失补齐） |
| `roles` | `organization_id`, `code`, `name`, `is_system`, `@@unique([organization_id, code])` | **要**（4 行预设） |
| `role_permissions` | `@@id([role_id, permission_code])` | **要**（107 行） |
| `users` | `email varchar(254)`, `password_hash`, `display_name`, `status` | **要**（1 行） |
| `organization_memberships` | `@@unique([organization_id, user_id])` | **要**（1 行，owner） |
| `signing_keys` | `kid unique`, `public_key Bytes`, `private_key_ref`, `status`, `not_before` | **要**（1 把 active Ed25519） |
| `installer_records` | 本次新增 | **要**（1 行，安装凭据） |

权限与角色预设来自 `src/lib/domain/permissions.ts`：`ALL_PERMISSION_CODES`（35 个）、`ROLE_PRESETS`（owner / admin / operator / viewer，全部 `is_system: true`）。

---

## 5. 迁移系统

`prisma/migrations/` 有 9 个迁移（审计时为 8 个，本轮新增 `20261104120000_installer_records`），建出 **41 张表**（本轮后 42 张）。

`prisma7.config.ts`：

```ts
defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.LICENSE_DB_URL ?? DEV_DATABASE_URL },
});
```

**对安装器的约束**：规格第 10 章要求"兼容项目原有迁移系统（优先适配，不重造）"。所以安装器**不自己写迁移引擎**，而是调用 `node_modules/.bin/prisma migrate deploy`，再读 `_prisma_migrations` 汇报结果。

---

## 6. 数据库客户端与配置的坑

`src/lib/db.ts` 用 `PrismaPg` + `globalThis` 单例，**在模块加载时读 `config`**。

```ts
const adapter = new PrismaPg({ connectionString: config.databaseUrl });
```

这意味着：安装器**不能**用这个单例去连"用户刚填的那个库"——它永远连的是进程启动时的 `LICENSE_DB_URL`。
所以 Adapter 必须按表单提交的连接串**现建**一个 `PrismaClient`，用完 `$disconnect()`。

`src/lib/config.ts` 的 `DEV_DEFAULTS` 会在 `LICENSE_DB_URL` 缺失时静默回退到
`postgresql://<用户>:<密码>@127.0.0.1:55432/<库名>?schema=public`。
这个回退在生产上很危险（会连到开发库却不报错），安装器的状态判定必须**显式**传连接串，不能只读 `process.env`。

---

## 7. 启动期行为（碰不得）

`src/instrumentation.ts` 在进程启动时：

1. 跑生产安全闸门（`DEPLOYMENT_ENV=production` 时校验若干密钥是否还是默认值）
2. 拉起 webhook 投递器
3. 拉起备份调度器

**项目没有 `src/middleware.ts`。** Next 16 里 middleware 已改名为 `proxy`（`src/proxy.ts`），本轮用它做根路径门禁。

---

## 8. 部署形态

```ini
# /etc/systemd/system/licensing-saas.service（节选）
[Service]
WorkingDirectory=/root/授权saas
Environment=NODE_ENV=production
EnvironmentFile=/etc/licensing-saas/production.env
ExecStart=/usr/bin/npm run start -- -p 3100 -H 127.0.0.1
Restart=on-failure
```

沙箱单元只换三处：`Description`、`EnvironmentFile=/etc/licensing-saas/sandbox.env`、`-p 3101`。

**对安装器的约束**：安装器写运行配置时默认目标是 `/etc/licensing-saas/production.env`（可用 `INSTALLER_ENV_FILE` 覆盖），并且**必须保留已有键**、只补缺失的——因为生产 env 文件里已经有一批手工配置过的值（`DEPLOYMENT_ENV`、`PUBLIC_API_BASE_URL`、`METRICS_TOKEN` 等）。

---

## 9. 现有实例的实际状态（不能破坏的东西）

| 项 | 值 |
| --- | --- |
| 生产库 `licensing` | 41 张表，8 个迁移，`organizations=1`、`customers=14`、`license_keys=232`、`activations=444` |
| 生产服务 | `licensing-saas.service` active，3100 |
| 沙箱服务 | `licensing-saas-sandbox.service` active，3101 |
| 反向代理 | openresty 占 80/443，`<你的域名>` + `<你的沙箱域名>` |
| 备份调度 | `licensing-saas-retention.timer` 每日 04:30 |

**验收标准 K（不影响现有项目正常运行）是硬约束**：安装器上线后，现网 `/` 必须仍然是 307 → `/app/dashboard`，不能变成跳 `/install`。

---

## 10. 审计结论：缺口清单

| # | 缺口 | 严重度 | 由谁补 |
| --- | --- | --- | --- |
| 1 | 没有安装入口页面 | P0 | Layer 3 UI |
| 2 | 没有环境检测 | P0 | Layer 1 `env-probe.ts` |
| 3 | 没有数据库连接测试与预检 | P0 | Layer 1 `database.ts` |
| 4 | 没有管理员初始化能力 | P0 | Layer 2 Adapter |
| 5 | 没有安装状态持久化 | P0 | Layer 1 `store.ts` |
| 6 | 没有安装互斥锁 | P0 | Layer 1 `lock.ts` |
| 7 | 没有失败恢复机制 | P0 | Layer 1 `orchestrator.ts` + 状态机 |
| 8 | 没有安装完成后的入口关闭 | P0 | `proxy.ts` + 状态机 `isInstallLocked` |
| 9 | 没有 Adapter 抽象 | P1 | Layer 1 `contract.ts` |
| 10 | 没有 Manifest 规范与校验 | P1 | Layer 1 `manifest.ts` |
| 11 | 没有安装期 CSRF / 同源 / 限流 | P0 | Layer 1 `guard.ts` |
| 12 | 没有安装审计记录 | P1 | 新增 `installer_records` 表 |

**这 12 项就是 Phase 2 架构要解决的问题。** 详见 [PHASE2-ARCHITECTURE.md](./PHASE2-ARCHITECTURE.md)。
