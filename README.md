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

### 1.2 装依赖、建表、灌种子

```bash
npm install
npm run db:migrate     # prisma migrate deploy
npm run db:seed        # 重建演示数据
```

> **数据库连接串**：本项目用自有变量 `LICENSE_DB_URL`（默认值已指向上面的本地容器），
> 刻意不使用通用的 `DATABASE_URL`——本机存在其它项目的 `.env`，用通用名会被污染成
> 别处的数据库地址。要改地址就设 `LICENSE_DB_URL`。

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
npm run test                                   # 75 个单元测试（7 个文件）
npx vitest run -c vitest.integration.config.ts # 12 个集成测试（需 dev/prod 服务 + 种子数据）
npm run e2e                                    # 16 个端到端（自带 next start -p 3001）

# 六语言 SDK 示例联调（Python / Node / PHP / Go / Java / C#，见 sdk-examples/README.md）
LICENSE_KEY=<授权码> LICENSE_PRODUCT_ID=<产品 UUID> node sdk-examples/verify.mjs
```

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
│  └─ /app/devices                   激活设备
├─ 开发者中心
│  ├─ /app/developer/api             API 接入（真实连通性自检）
│  ├─ /app/developer/credentials     API 凭证
│  ├─ /app/developer/webhooks        Webhook 端点
│  └─ /app/developer/webhooks/[id]   投递记录与重投
├─ 安全审计
│  ├─ /app/security/signing-keys     签名密钥
│  ├─ /app/security/verification-logs 验证日志
│  └─ /app/security/audit-logs       操作审计
└─ 系统管理
   ├─ /app/settings/members          管理员与角色
   ├─ /app/settings/organization     组织设置（时区）
   ├─ /app/settings/system           系统设置
   ├─ /app/settings/backups          备份与灾备（目标/策略/作业/演练）
   └─ /app/settings/profile          个人设置（资料/改密/MFA）
```

共 43 个页面路由（后台 23 + 开发者文档 16 + 认证 3 + 根重定向 1）、
71 个 API 路由（管理 50 / 认证 5 / 公开协议 11 / 开发者文档 5），
其中备份与灾备占 12 个管理路由、公开协议里含 3 个 v1.5 新增端点。

### 3.1 授权详情页的 6 个 Tab

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
│  └─ api/v1/                 66 个 route handler
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
├─ unit/                      75 个纯函数与契约测试（7 个文件）
├─ integration/               12 个真实 HTTP + DB 测试
└─ e2e/                       16 个 Playwright 用例（6 个文件）
docs/                         交付文档（见下）
```

---

## 6. 文档

| 文件 | 内容 |
| --- | --- |
| [`docs/design-system.md`](docs/design-system.md) | 设计 Token、组件规范、按钮七状态、响应式断点、禁用清单 |
| [`docs/vibehub-terminology.md`](docs/vibehub-terminology.md) | VibeHub 安装记录、20+ 术语对照（带真实内链）、术语如何改变实现 |
| [`docs/api.md`](docs/api.md) | 统一响应、错误码表、66 个 route handler、公开 API 流程、页面↔接口清单 |
| [`docs/ai-integration-prompt.md`](docs/ai-integration-prompt.md) | 给 AI 编程工具的接入提示词（禁止事项、值分级、自检清单） |
| [`docs/v15-audit.md`](docs/v15-audit.md) | v1.5 规格包逐条审计与 P0/P1/P2 落地状态 |
| [`docs/test-report.md`](docs/test-report.md) | 测试结果、15.10 十二条验收、15.11 交付清单、未覆盖项 |
| [`docs/handoff.md`](docs/handoff.md) | 已完成/待办、快速恢复、踩坑清单 |
| [`sdk-examples/README.md`](sdk-examples/README.md) | 六语言示例、错误映射表、各平台踩坑（Preview 状态，非已发布 SDK） |
| [`docs/shots/`](docs/shots) | 29 张真实页面截图（生产构建 + 种子数据，桌面与移动端） |

---

## 7. 安全约定

- 授权码只存 HMAC-SHA256 摘要，列表展示打码为 `••••-••••-••••-3456`，明文只在签发时出现一次；
- 凭证 secret 只存 SHA-256，公开客户端不签发 secret；
- 签名私钥落盘 `.keys/<kid>.pem`，权限 `0600`，不进 Git；
- 会话 Cookie `HttpOnly` + `SameSite=Lax`，`Secure` 按实际协议决定（HTTPS 部署自动开启）；
- 所有写操作要求 CSRF 双提交令牌；
- 每个管理写操作都写 `audit_logs`（含前后值 diff，敏感字段脱敏）。
