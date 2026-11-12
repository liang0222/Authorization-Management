# 子铭 · 软件授权管理后台

面向 ISV 的通用软件授权管理 SaaS 的管理后台。核心业务：给软件产品定义功能与套餐、
给客户签发授权码、按设备绑定激活、按周期续费与暂停，并把每一次验证与每一次人工操作都留痕。

技术栈（未替换、未降级）：

```
Next.js 16.4.3（App Router + Cache Components）
React 19.3 · TypeScript 5
Tailwind CSS 4 · shadcn/ui（radix-nova，29 个组件）
Prisma 7.10.1 + PostgreSQL 16（驱动适配器 @prisma/adapter-pg）
Vitest 5（单元 + 集成）· Playwright 1.64（端到端）
```

---

## 1. 快速开始

### 1.1 起数据库

```bash
docker run -d --name licensing-pg \
  -e POSTGRES_PASSWORD=licensing_dev_pw \
  -e POSTGRES_USER=licensing \
  -e POSTGRES_DB=licensing \
  -p 55432:5432 postgres:16-alpine
```

### 1.2 装依赖、生成 Prisma Client、建表、灌种子

```bash
npm install
npx prisma generate    # 生成 Prisma Client 到 src/generated/prisma
npm run db:migrate     # prisma migrate deploy
npm run db:seed        # 重建演示数据
```

> ⚠️ **`npm run db:seed` 是破坏性操作**：`prisma/seed.ts:79` 先对 30 张业务表执行
> `TRUNCATE ... RESTART IDENTITY CASCADE`，再重灌演示数据——**不是增量，是清空**。
> 它打的是 `LICENSE_DB_URL` 指向的库，而这个变量的默认值就是本地 `licensing` 库。
> 如果这台机器上跑着连同一库的服务实例，灌种子会把这些实例的数据一起清掉
> （症状之一：`signing_keys` 变成新生成的 kid，服务读不到对应私钥，`/health/ready` 返 503
> `signing_key_unreadable`）。跑之前务必显式指定一个**专用库**，例如：
>
> ```bash
> LICENSE_DB_URL="postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing_scratch?schema=public" \
>   npm run db:seed
> ```
>
> 集成测试与 e2e 同理，别对着有数据的库跑。

> **`npx prisma generate` 不能省。** `src/generated/prisma/` 是生成物，已写进 `.gitignore`，
> 仓库里没有它。缺这一步时 `npm run typecheck` 会报一片「找不到模块 `@/generated/prisma`」，
> `tests/unit/` 里引到 Prisma 类型的用例也会失败——看起来像代码坏了，实际只是没生成。
> 本项目刻意没挂 `postinstall` 自动跑（避免 CI 上重复生成），必须显式执行。

> **数据库连接串**：本项目用自有变量 `LICENSE_DB_URL`（默认值已指向上面的本地容器），
> 刻意不使用通用的 `DATABASE_URL`——本机存在其它项目的 `.env`，用通用名会被污染成
> 别处的数据库地址。要改地址就设 `LICENSE_DB_URL`。

> **构建期替身（阶段 0.5 修复，2026-11）**：`ssh2` 的 optionalDependency `cpu-features` 带原生 addon
> `build/Release/cpufeatures.node`，干净 `npm install` / `npm ci` 会把它装上并编译成功；Turbopack 打包
> `ssh2`（SFTP 备份适配器 → `src/instrumentation.ts`）时无法把原生 addon 放进 ESM chunk，报
> `non-ecmascript placeable asset`，**build 失败**。
> 修法：`next.config.ts` 的 `turbopack.resolveAlias` 把 `cpu-features` 指向构建期替身
> [`src/lib/shims/cpu-features-noop.cjs`](src/lib/shims/cpu-features-noop.cjs)（一个返回 `undefined` 的函数）。
> `ssh2` 的调用点是 `try { require('cpu-features')() } catch {}`，替身等价于「该可选包不存在」，
> 加密实现回退到纯 JS —— 与不装该包时行为一致，SFTP 功能不受影响
> （已用真实 SFTP 服务器验证：主机指纹 + 建目录 + 上传 + 下载比对 + 删除五步全 PASS）。
> `serverExternalPackages` 与 `--omit=optional` 实测无效（后者会连带移除 `pg-cloudflare`），不要回头再试。
> 复现记录与修复前后对比见 [`docs/test-report.md`](docs/test-report.md) 第 1.1 节。

### 1.3 起服务

```bash
npm run dev            # http://localhost:3000
```

### 1.4 登录

| 账号 | 角色 | 密码 | 能做什么 |
| --- | --- | --- | --- |
| `owner@xinglan.dev` | owner | `License#2026` | 全部权限 |
| `ops@xinglan.dev` | operator | `License#2026` | 签发/续费/暂停/解绑，不能改产品与组织 |
| `audit@xinglan.dev` | viewer | `License#2026` | 只读（用于验证权限门控） |

组织：星岚软件（时区 `Asia/Shanghai`）。

### 1.5 跑测试

```bash
npm run typecheck                              # tsc --noEmit
npm run test                                   # 302 个单元测试（22 个文件）
npx vitest run -c vitest.integration.config.ts # 12 个集成测试（需 dev/prod 服务 + 种子数据）
npm run e2e                                    # 16 个端到端（自带 next start -p 3001）

# 六语言 SDK 示例联调（Python / Node / PHP / Go / Java / C#，见 sdk-examples/README.md）
LICENSE_KEY=<授权码> LICENSE_PRODUCT_ID=<产品 UUID> node sdk-examples/verify.mjs
```

> 上面四个数量都是**实跑值**，口径与复现命令：
> 单元 `npx vitest run` → `Test Files 22 passed (22) / Tests 302 passed (302)`；
> 集成 `npx vitest run -c vitest.integration.config.ts` → `Tests 12 passed (12)`（先 `npm run db:seed`，
> 脏库会让并发那条偶发失败）；端到端 `npx playwright test --list` → `Total: 16 tests in 7 files`。
> 端到端 16 条里有 2 条（`tests/e2e/05-backups.spec.ts` 的「被策略引用的目标不允许直接删除」与
> 「立即备份 → 完整性校验 → 隔离恢复演练」）依赖库里已存在备份目标/策略，而 `prisma/seed.ts`
> 不建备份数据，纯净种子下必然失败——见 [`docs/test-report.md`](docs/test-report.md) 第 4 节。

---

## 2. 技术基线

实现遵循 `licensing_saas_technical_spec_v1.2.md`，几个容易做错、本项目明确实现对的点：

| 规格 | 要求 | 落实位置 |
| --- | --- | --- |
| 0.1 | 一季度 = `month 3`、一年 = `month 12`（自然月，月末钳制），不是 90/365 天 | `src/lib/domain/period.ts` |
| 0.1 | 永久授权 `expires_at` 为 NULL | 同上，`addDuration` 返回 `null` |
| 0.2 | 起算方式 `on_first_activation` / `fixed_start` | 激活事务内写 `starts_at` |
| 3.2 | `effective_status` 九级优先级 | `src/lib/domain/effective-status.ts`；列表筛选在 SQL 里复刻同一套 CASE |
| 3.2 | 次数/设备上限**只影响新激活** | `computeEffectiveState` 的 `activationBlockReason` 分支 |
| 3.4 | 首激活 `SELECT ... FOR UPDATE` | `src/lib/services/activations.ts` |
| 3.5 | 未到期顺延、已过期从 `server_now` | `renewalStart` |
| 4.4 | 统一错误码表 | `src/lib/http/api.ts` |
| 4.7 | 激活需 `Idempotency-Key` | `src/lib/http/public-api.ts`（回放带 `x-idempotent-replay`） |
| 8 | 10 种 Webhook 事件 | `src/components/developer/webhook-dialogs.tsx`、投递队列 |
| 15 | 后台 UI/UX 规范 | [`docs/design-system.md`](docs/design-system.md) |

---

## 3. 页面地图

```
/                                    → 重定向到 /app/dashboard
/login · /forgot-password · /reset-password   认证（独立布局，无侧栏）

/app（后台布局：Sidebar + Topbar + 内容区 + 页脚）
├─ 工作台
│  └─ /app/dashboard                 数据总览
├─ 业务管理
│  ├─ /app/products                  软件产品列表
│  ├─ /app/products/[id]             产品详情（概览/功能/套餐/凭证）
│  ├─ /app/customers                 客户管理
│  ├─ /app/customers/[id]            客户档案（资料/授权/身份绑定）
│  ├─ /app/plans                     授权套餐
│  ├─ /app/features                  功能权限（跨产品）
│  ├─ /app/licenses                  授权管理
│  ├─ /app/licenses/[id]             授权详情（6 个 Tabs）
│  ├─ /app/devices                   激活设备
│  └─ /app/devices/[id]              设备详情（档案/绑定/事件）
├─ 开发者中心
│  ├─ /app/developer/api             API 接入（真实连通性自检）
│  ├─ /app/developer/credentials     API 凭证
│  ├─ /app/developer/usage           调用量、成功率、错误码分布
│  ├─ /app/developer/webhooks        Webhook 端点
│  └─ /app/developer/webhooks/[id]   投递记录、重投与测试投递
├─ 安全审计
│  ├─ /app/security/signing-keys     签名密钥
│  ├─ /app/security/verification-logs 验证日志
│  └─ /app/security/audit-logs       操作审计
└─ 系统管理
   ├─ /app/settings/members          管理员
   ├─ /app/settings/roles            角色与权限
   ├─ /app/settings/organization     组织设置（时区）
   ├─ /app/settings/system           系统设置
   ├─ /app/settings/backups          备份与灾备（目标/策略/作业/演练）
   └─ /app/settings/profile          个人设置（资料/改密/MFA）
```

共 49 个页面路由、74 个 API 路由、82 个 route handler（含开发者文档与运维端点），
其中备份与灾备占 12 个管理路由、公开协议里含 4 个 v1.5 新增端点
（`GET /v1/activations/{id}`、`POST /v1/server/licenses/check`、`POST /v1/offline-grants`、`POST /v1/oauth/token`）。

统计口径（2026-11 实测，命令可直接复跑）：

| 数字 | 口径 | 命令 |
| --- | --- | --- |
| 49 个页面 | 全部 `page.tsx`：后台 `app/` 26 + 开发者文档 `developers/` 17 + 认证 `(auth)/` 3 + 根重定向 1 + `/install` 1 + `/openapi` 1 | `find src/app -name 'page.tsx' \| wc -l` |
| 74 个 API 路由 | `src/app/api/` 下全部 `route.ts`：`api/install` 4 + `api/v1/admin` 54 + `api/v1/auth` 5 + `api/v1` 公开 11 | `find src/app/api -name 'route.ts' \| wc -l` |
| 82 个 route handler | 上面 74 + `developers/` 5 个静态文档 route + `/health/live`、`/health/ready`、`/metrics` 3 个 | `find src/app -name 'route.ts' \| wc -l` |
| 12 个备份路由 | `src/app/api/v1/admin/backups/**` | `find src/app/api/v1/admin/backups -name 'route.ts' \| wc -l` |

> 注：`/install` 与 `/openapi` 是 v1.5 后加的页面（安装器与在线契约浏览），早期那一版
> 页面口径只算了「后台 26 + 开发者 16 + 认证 3 + 根 1」，既漏掉这两个，也漏掉
> `developers/` 后续新增的 `/developers/openapi` 一页，所以对不上。

### 3.1 部署形态

| 实例 | 监听 | `DEPLOYMENT_ENV` | 数据库 | 签名密钥 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `licensing-saas` | `127.0.0.1:3100`（反代 `<你的域名>`） | `production` | `licensing` | `.keys-prod` | 真实客户 |
| `licensing-saas-sandbox` | `127.0.0.1:3101` | `sandbox` | `licensing_sandbox` | `.keys-sandbox` | 接入联调 |

生产环境变量在 `/etc/licensing-saas/production.env`（0600，systemd `EnvironmentFile` 注入，
优先于项目 `.env`）；模板见 [`.env.example`](.env.example)。两个实例共用同一份构建产物，
隔离靠数据库、密钥目录、限流前缀与凭证的 `environment` 字段，不靠部署到不同机器。

### 3.2 授权详情页的 6 个 Tab

概览（含有效状态推导、配额进度、时间线）· 激活设备（解绑/禁用）· 功能权限（合并套餐默认值
与授权快照）· 续费记录 · 验证日志 · 操作历史。

---

## 4. 业务闭环

### 4.1 人工侧（后台）

```
建产品 → 定义功能（code/类型/默认值）→ 建套餐（周期/设备数/功能覆盖）
→ 建客户 → 签发授权（选产品+套餐，生成兑换码）→ 客户激活 → 设备出现在「激活设备」
→ 需要时：续费（顺延）/ 暂停（停心跳）/ 解绑 / 撤销（终态）
```

### 4.2 客户端侧（公开 API）

```
POST /v1/activation-challenges   拿挑战（含 canonical_message）
→ 本地用 Ed25519 私钥签名
→ POST /v1/activations           带 x-client-id + Idempotency-Key
→ POST /v1/activations/heartbeat 定期心跳（返回新 token，旧的立即失效）
→ GET  /v1/activations/[id]/entitlements  读功能开关
→ POST /v1/activations/deactivate         解绑
```

在后台 `/app/developer/api` 页可直接点「连通性自检」，用真实凭证发一次挑战请求并看到响应。

---

## 5. 目录结构

```
src/
├─ app/
│  ├─ (auth)/                 登录、忘记密码、重置密码
│  ├─ app/                    后台（layout 为 AppShell）
│  └─ api/v1/                 70 个 route handler（另 api/install 4 个）
│     ├─ auth/                登录、登出、会话、找回/重置密码
│     ├─ admin/               管理接口（全部 withAdmin + RBAC）
│     └─ (根)                 公开客户端接口
├─ components/
│  ├─ app/                    16 个通用组件（Shell/表格/筛选/反馈/徽章/图表…）
│  ├─ ui/                     29 个 shadcn/ui 基础控件
│  ├─ catalog/                产品、客户、套餐、功能的表单弹窗
│  ├─ developer/              凭证与 Webhook 弹窗
│  ├─ licensing/              签发抽屉、授权操作、功能覆盖编辑器、激活操作
│  ├─ security/               日志抽屉、签名密钥弹窗
│  └─ settings/               成员弹窗
├─ lib/
│  ├─ domain/                 周期、有效状态、授权码、权限、审计（纯函数）
│  ├─ auth/                   密码、TOTP、会话、CSRF、密钥封装
│  ├─ http/                   响应封装、错误码、限流、公共 API 中间件
│  ├─ services/               业务事务（签发、续费、激活…）
│  │  ├─ client/                 前端 fetch 封装、useResource、会话上下文
│  ├─ developers/             文档中心导航、llms.txt 生成器（由契约派生）
│  └─ config.ts               LICENSE_DB_URL / SESSION_SECRET / 签名密钥目录
├─ generated/prisma/          Prisma Client（生成物，勿手改）
prisma/
├─ migrations/                DDL 的唯一事实来源
├─ schema.prisma              由 db pull 自省生成
└─ seed.ts                    演示数据
sdk-examples/                 六语言可运行示例 + verify.mjs（Preview，非已发布 SDK）
tests/
├─ unit/                      302 个纯函数与契约测试（22 个文件）
├─ integration/               12 个真实 HTTP + DB 测试
└─ e2e/                       16 个 Playwright 用例（7 个文件，含 setup）
docs/                         交付文档（见下）
```

---

## 6. 文档

### 6.1 开发与接口

| 文件 | 内容 |
| --- | --- |
| [`docs/api.md`](docs/api.md) | 统一响应与错误码表、全部 route handler、公开 API 流程、列表分页（含游标）、页面↔接口清单 |
| [`docs/design-system.md`](docs/design-system.md) | 设计 Token、组件规范、按钮七状态、响应式断点、禁用清单 |
| [`docs/ai-integration-prompt.md`](docs/ai-integration-prompt.md) | 给 AI 编程工具的接入提示词（禁止事项、值分级、自检清单） |
| [`sdk-examples/README.md`](sdk-examples/README.md) | 六语言示例、错误映射表、各平台踩坑（全部 Preview，非已发布 SDK） |
| [`public/openapi/openapi-v1.yaml`](public/openapi/openapi-v1.yaml) | 对外契约（OpenAPI 3.1），与 `src/app/api/v1` 逐条核对 |

### 6.2 运行与运维

| 文件 | 内容 |
| --- | --- |
| [`docs/v15-runbook.md`](docs/v15-runbook.md) | 部署形态、日常命令、发布、备份恢复、私钥离线备份、沙箱重建、回滚、常见故障 |
| [`docs/operations.md`](docs/operations.md) | 发布管理、容量与成本、事件响应（含密钥泄漏处置与客户通告模板）、状态页、日常任务 |
| [`docs/observability.md`](docs/observability.md) | `/health/live`·`/health/ready`·`/metrics`、指标清单、日志前缀、告警分级、排障路径 |
| [`SECURITY.md`](SECURITY.md) | 漏洞报告流程、支持范围、设计上的安全边界、部署侧必做项 |
| [`docs/privacy.md`](docs/privacy.md) | 采集范围、保留期限、脱敏、导出、删除与匿名化、跨境 |

### 6.3 过程记录

| 文件 | 内容 |
| --- | --- |
| [`CHANGELOG.md`](CHANGELOG.md) | v1.5.0 的完整变更记录与已知限制 |
| [`docs/v15-audit.md`](docs/v15-audit.md) | v1.5 规格包逐条审计与 P0/P1/P2 落地状态（审计阶段快照） |
| [`docs/v15-delivery.md`](docs/v15-delivery.md) | P0/P1 完成表（含实现位置与证据）、未完成项、本轮修的 5 个真缺陷、验证命令 |
| [`docs/test-report.md`](docs/test-report.md) | 测试结果、15.10 十二条验收、15.11 交付清单、未覆盖项 |
| [`docs/handoff.md`](docs/handoff.md) | 已完成/待办、快速恢复、踩坑清单 |
| [`docs/vibehub-terminology.md`](docs/vibehub-terminology.md) | VibeHub 安装记录、20+ 术语对照（带真实内链）、术语如何改变实现 |
| `docs/shots/` | 页面截图（31 张，虚构种子数据） |

---

## 7. 安全约定

- 授权码只存 HMAC-SHA256 摘要，列表展示打码为 `••••-••••-••••-3456`，明文只在签发时出现一次；
  换 pepper 走版本环（新值签发、旧值只读校验并就地重哈希），不会让存量授权码失效；
- 凭证 secret 只存 SHA-256，公开客户端不签发 secret；
- MFA 密钥、Webhook 签名密钥、备份存储凭证用 `SECRETBOX_KEY` 做 AES-256-GCM 信封加密，
  与 `SESSION_SECRET` 分离，支持密钥环轮换（`scripts/rotate-secrets.mts`）；
- 签名私钥落盘 `.keys-prod/<kid>.pem`（生产）/ `.keys-sandbox/`（沙箱），权限 `0600`，不进 Git，
  接口只暴露公钥指纹，私钥无下载路径；
- 会话 Cookie `HttpOnly` + `SameSite=Lax`，`Secure` 按 `APP_BASE_URL` 的协议自动开启；
- 所有写操作要求 CSRF 双提交令牌；
- 每个管理写操作都写 `audit_logs`（含前后值 diff，敏感字段脱敏）；
- Webhook 出站强制 SSRF 校验（私网/链路本地/云元数据/CGNAT/IPv6 ULA 全拒，DNS 解析后逐 IP 复核）；
- **生产启动闸门（阶段 1 收紧）**：判定只看 `NODE_ENV`——生产构建只要 `bootSafetyIssues()` 非空就
  `process.exit(1)`，与 `DEPLOYMENT_ENV` 写什么都无关。拦的是：`SESSION_SECRET` / `LICENSE_HMAC_PEPPER` /
  `BACKUP_ENCRYPTION_KEY` 仍是开发默认值、`DEV_MAIL_SINK≠false`、生产共用开发签名目录、
  以及「`NODE_ENV=production` 但 `DEPLOYMENT_ENV` 是 development」这种把生产构建当开发跑的错配
  （sandbox 例外：它是显式隔离部署，另有 `.keys` / `.backups` 不得与生产共用的独立规则）。
  只 `throw` 不够——Next 16 会吞掉 instrumentation 异常并继续监听端口、所有请求回 500，
  systemd 仍显示 `active`，所以这里显式退出；单测在 `tests/unit/boot-gate.test.ts`；
- **全站安全响应头（阶段 1）**：`next.config.ts` 关掉 `X-Powered-By`，并对 `/:path*` 统一下发
  `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`（关 camera/microphone/geolocation）
  与 `Content-Security-Policy-Report-Only`（先只报告不拦截，避免 Next 内联脚本被打挂；
  转正式头的步骤写在 `next.config.ts` 的注释里）。
  注意反向代理：`docs/DEPLOY-v15.md` 的 nginx 片段也加了 `X-Frame-Options SAMEORIGIN`，
  上生产时删掉 nginx 那条，只留应用层，否则同一响应里出现两个 `X-Frame-Options`。
- **生产防呆护栏（阶段 2）**：`prisma/seed.ts` 在**连库之前**判断身份——`NODE_ENV=production` 或
  `DEPLOYMENT_ENV=production` 时默认拒绝执行（退出码 1），只有显式 `ALLOW_DEMO_SEED=true` 才放行，
  且放行前打 ⚠️ 横幅（它会 TRUNCATE 30 张表）。`DEPLOYMENT_ENV=production` 启动时还会查 `users` 表，
  发现 `*@xinglan.dev` 或种子 displayName 的账号就并入启动闸门拦下（阶段 1 规则 → 退出码 1）；
  查库失败（全新实例还没建表）只降级为警告，不拦安装器。单测在 `tests/unit/seed-guard.test.ts`、
  `tests/unit/demo-accounts.test.ts`。
- **上线前自检（阶段 2）**：`npm run check:prod-env -- --env-file /etc/licensing-saas/production.env`
  （不传 `--env-file` 则读当前目录 `.env`）。逐项输出 PASS/FAIL，任一 FAIL 退出码 1，
  可直接串进发布脚本。九项：四把密钥（`SESSION_SECRET` / `LICENSE_HMAC_PEPPER` / `BACKUP_ENCRYPTION_KEY` /
  `SECRETBOX_KEY`）是否仍是开发默认值、`DEPLOYMENT_ENV` 是否 production、`DEV_MAIL_SINK` 是否 false、
  `SIGNING_KEY_DIR` 是否还是 `.keys`、`APP_BASE_URL` 是否 https、`LICENSE_DB_URL` 是否仍在用开发口令。
  **只输出结论**：不打印密钥值、长度、片段，连接串只报 host 与口令性质。
