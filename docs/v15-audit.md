# v1.5 升级审计报告（第一轮：只审计，不改代码）

- 审计时间：2026-11-02
- 审计对象：`/root/授权saas`（现有实现，v1.4 已交付）+ v1.5 规格包
- 规格基线：`licensing_saas_technical_spec_v1.5_complete.md`（3728 行）、`licensing_saas_developer_api_guide_v1.5.md`（509 行）、`openapi-v1.yaml`（973 行）、`openapi-v1.json`（1510 行）、`licensing_saas_linux_deployment_v1.5.md`（1070 行）、`licensing_saas_ai_incremental_update_prompt_v1.5.md`（103 行）、`llms.txt` / `llms-full.txt`、`README_FIRST_v1.5.md`
- 本轮产出：功能完成度矩阵 + P0/P1/P2 差距表 + 兼容方案。**未修改任何业务代码、数据库、迁移、配置。**

---

## 0. 结论摘要

现有项目在「授权核心域 + 管理后台」已经完成度很高，v1.5 的缺口高度集中在**三块新增面**：

1. **公开开发者文档中心（27 章）**：完全没有。无 `/developers` 路由、无 OpenAPI 文件、无 `llms.txt`、无 SDK 示例。
2. **多协议异地备份与灾备（16.10–16.12）**：完全没有。无备份表、无备份服务、无备份页面、无 Docker/CI 产物。
3. **Sandbox / Production 隔离（27.3）**：完全没有。只有单一数据库、单一签名密钥目录、单一凭证池。

此外还有一处**"看起来实现了、其实没实现"的高风险点**：

> **Webhook 只有入队，没有投递器。** `enqueueWebhook()` 只往 `webhook_deliveries` 写 `status=pending`，全仓库没有任何对外 HTTP 投递代码、没有 worker/cron，`replay` 接口也只是把状态重置为 `pending`。规格 8 要求的签名头、5 分钟窗口、退避重试、死信、SSRF 防护全部缺失。

以及一组**协议契约偏差**（4.6–4.13）：挑战规范化消息缺版本前缀、激活响应缺 8 个字段、心跳/解绑用 Bearer 而非 refresh token、缺 4 个端点（`GET /activations/{id}`、`POST /server/licenses/check`、`POST /offline-grants`、`POST /oauth/token`）、公开 API 零限流、`entitlements_version` 不存在。

---

## 1. 审计方法与证据来源

| 步骤 | 命令 / 方法 | 结论来源 |
|---|---|---|
| 读规格包 | 解压到 `/tmp/v15`，逐文件读结构与关键章节 | 9 个文件、行数见上 |
| 扫路由 | `find src/app/api -name route.ts` + 提取 `export async function (GET\|POST\|PUT\|PATCH\|DELETE)` | 47 条 API 路由 |
| 扫页面 | `find src/app -name page.tsx` | 26 个页面路由 |
| 扫数据库 | `grep -c "CREATE TABLE" prisma/migrations/.../migration.sql` | 31 张表 |
| 扫公开 API 契约 | 逐文件读 `src/app/api/v1/**/route.ts` + `src/lib/services/activations.ts` | 字段级对照见 §4 |
| 扫限流 | `grep -rn "rateLimit" src` | 只命中登录/忘记密码 |
| 扫 Webhook 投递 | `grep -rn "fetch(" src/lib`、`grep -rn "setInterval\|cron" src` | 无对外发送、无 worker |
| 扫隔离/备份/文档/SDK | `grep -rli "sandbox\|webdav\|sftp\|@aws-sdk\|backup" src prisma scripts`、`ls Dockerfile* docker-compose* .github` | 全部无命中 |
| 扫配置 | `cat src/lib/config.ts`、`ls -a \| grep env` | 6 个环境变量、无 `.env.example` |

---

## 2. 系统现状事实清单

| 维度 | 现状 | 证据 |
|---|---|---|
| 数据表 | **31 张**（含 `activation_refresh_tokens`、`offline_grants` 两张**建了但没接线**的表） | `prisma/migrations/20261102000000_init/migration.sql` |
| API 路由 | **47 条**：公开运行时 6 条 + 管理/认证 41 条 | `src/app/api/v1/**/route.ts` |
| 页面路由 | **26 个** | `src/app/**/page.tsx` |
| 单元测试 | 44 passed（period / effective-status / license-key / activation-token） | `tests/unit/*.test.ts` |
| 集成测试 | 11 passed（真实 HTTP + 真实 PostgreSQL + 真实 Ed25519 签名） | `tests/integration/api.test.ts` |
| E2E | 11 passed（含 21 条路由巡检、响应式） | `tests/e2e/*.spec.ts` |
| 构建 | 59/59 页 | `npm run build` |
| 种子数据 | 1 组织 / 4 产品 / 14 客户 / 240 授权 / 444 激活 / 3 Webhook 端点 / 260 验证日志 | `prisma/seed.ts` |
| 部署产物 | **无** Dockerfile、无 docker-compose、无 `.github` CI、无 `.env.example` | `ls` 根目录 |
| 环境变量 | 6 个：`LICENSE_DB_URL`、`SESSION_SECRET`、`LICENSE_HMAC_PEPPER`、`APP_BASE_URL`、`SIGNING_KEY_DIR`、`DEV_MAIL_SINK` | `src/lib/config.ts` |

---

## 3. 功能完成度矩阵

状态定义：**完成**＝有真实代码 + 接口 + 测试；**部分**＝有代码但缺关键面；**缺失**＝无代码。

### 3.1 授权核心域

| 功能 | 状态 | 证据 | 差距 |
|---|---|---|---|
| 标准周期（7/15/30 天、季度、年、永久） | 完成 | `src/lib/domain/period.ts`、`tests/unit/period.test.ts` | — |
| 自然月计算 + 月末钳制 + 组织时区 | 完成 | 同上（`addCalendarMonths` / `zoneOffsetMs`） | — |
| 起算方式 `on_first_activation` / `fixed_start` | 完成 | `prisma/seed.ts`、`computeEffectiveState` | — |
| 管理状态机（draft/pending/active/suspended/revoked/cancelled） | 完成 | `src/lib/services/licenses.ts`、集成测试终态 409 | — |
| 有效状态计算（9 级优先级） | 完成 | `src/lib/domain/effective-status.ts`、15 条单测 | — |
| 签发（事务 + 快照合并 + 授权码 HMAC） | 完成 | `issueLicense`、`src/lib/domain/license-key.ts` | — |
| 续费（未到期顺延 / 已过期从 now） | 完成 | `renewLicense` + `license_renewals`，集成测试校验 ±5s | — |
| 换码 / 重置激活次数 / 批量签发 / CSV 导出 | 完成 | `rekeyLicense`、`/admin/licenses/batch`、`/admin/licenses/export` | — |
| 设备上限并发保护 | 完成 | `SELECT ... FOR UPDATE`，集成测试 `[201,409]` | — |

### 3.2 激活协议（v1.5 第 4 章）

| 端点 | 现状 | 规格要求 | 差距 | 优先级 |
|---|---|---|---|---|
| `POST /activation-challenges` | 有 | 同 | 响应缺 `signing_algorithm` | P1 |
| 挑战规范化消息 | 5 字段 `\n` 拼接 | 6 行，首行 `LICENSE-ACTIVATION-CHALLENGE-V1` | **缺版本前缀行** | **P0**（SDK 一旦发布就无法改） |
| `POST /activations` | 有（幂等 + 行锁） | 同 | 请求体 `signature` 在顶层（规格在 `device.signature`）、`client_version` 字符串（规格 `client:{app_version,sdk_version}`）；响应缺 `license_id/product_id/effective_status/starts_at/expires_at/duration/device_limit/activation_limit/refresh_token/refresh_token_expires_at/heartbeat_interval_seconds` | **P0** |
| `POST /activations/heartbeat` | Bearer 令牌 | `{activation_id, refresh_token, device_proof}` | 认证方式不同；无 refresh 轮换、无重放检测、无 `entitlements_version`、无 `next_heartbeat_seconds` | **P0** |
| `POST /activations/deactivate` | Bearer 令牌 | `{activation_id, refresh_token, reason}` | 同上；重复解绑幂等已实现 | P1 |
| `GET /activations/{id}` | **缺失** | 查询激活详情 | 端点不存在 | P1 |
| `GET /activations/{id}/entitlements` | 有 | 同 | 无 `entitlements_version` | P1 |
| `POST /licenses/validate` | 有（统一 `LICENSE_INVALID` 防枚举） | `{product_id, license_key}` | 未接收 `product_id`（由 X-Client-ID 推出）；**无限流** | P1 |
| `POST /server/licenses/check` | **缺失** | 可信服务端凭证 + subject assertion | 端点、凭证类型（`private_key_jwt`/mTLS）、断言验签全部缺失 | **P0** |
| `POST /offline-grants` | **缺失**（`offline_grants` 表已建） | Ed25519 签名离线文件 + `kid` | 端点与签发逻辑缺失 | P1 |
| `POST /oauth/token` | **缺失** | 浏览器插件 OAuth Code + PKCE | 端点与 PKCE 流程缺失 | P1 |
| 公开端点限流 | **无** | 按产品/凭证/IP/端点分层 + `RATE_LIMITED` + `Retry-After` | `withPublic` 无限流 | **P0** |

### 3.3 Webhook（规格 8）

| 功能 | 状态 | 证据 | 差距 |
|---|---|---|---|
| 事件入队 | 完成 | `enqueueWebhook()` → `webhook_deliveries(pending)` | — |
| **实际投递** | **缺失** | 全仓库无对外 `fetch`、无 worker | 无 HTTP 发送 |
| 签名头 `X-License-Signature: v1=<hex_hmac_sha256>` | **缺失** | — | 无 |
| 5 分钟时间窗 + `event_id` 去重 | **缺失** | — | 无 |
| 退避重试 + 死信 + 成功率 | **缺失**（表里有 `attempt_count`/`next_attempt_at`/`dead` 状态） | `webhook_deliveries` 表结构 | 无重试驱动 |
| SSRF 防护（禁私网/元数据/重定向复检） | **缺失** | — | 无 |

### 3.4 开发者中心（后台侧，27.19）

| 功能 | 状态 | 证据 | 差距 |
|---|---|---|---|
| 凭证列表/创建/轮换/禁用/归档 | 完成 | `/api/v1/admin/credentials*`、`/app/developer/credentials` | 缺 Scope 细粒度展示 |
| 公开客户端 vs 机密服务端区分 | 完成 | `product_credentials.client_type` + `secret_hash` 仅存哈希 | 机密服务端尚无可用凭证类型（`private_key_jwt`） |
| 签名密钥（Ed25519 生成/激活/退役/吊销） | 完成 | `/admin/signing-keys*`、私钥 PEM 0600 | 无私钥离线备份/恢复 |
| Webhook 配置 + 投递列表 + 重放 | 部分 | `/admin/webhooks*` | 重放只重置状态，不会真发 |
| 调用量/成功率/P95/错误码分布 | 部分 | `/admin/verification-logs` summary（total/success/failed/avgLatency） | 无 P95、无按端点/错误码分布图 |
| Sandbox/Production 切换 | **缺失** | — | 无环境概念 |
| SDK/文档版本与弃用通知 | **缺失** | — | 无 |

### 3.5 公开开发者文档中心（规格 27 章）

| 内容 | 状态 | 证据 |
|---|---|---|
| `/developers` 及 16 个子路由 | **缺失** | 页面路由清单无 `developers` |
| OpenAPI 3.1 YAML + JSON 可下载 | **缺失** | 仓库内无 `openapi*` 文件 |
| API Reference 渲染（Scalar/Redoc） | **缺失** | 无依赖、无页面 |
| Try it out（仅 Sandbox） | **缺失** | — |
| `llms.txt` / `llms-full.txt` | **缺失** | 无文件 |
| 概念/认证/错误码/限流/Webhook/版本策略文档 | **缺失** | 仅有内部 `docs/api.md`（258 行，不对外） |
| 平台接入页（Windows/插件/小程序/Web） | **缺失** | — |
| SDK 示例（Python/PHP/Node P0；Go/Java/C# P1） | **缺失** | 无 `sdk-examples/` |

### 3.6 Sandbox 隔离（规格 27.3）

| 要求 | 现状 |
|---|---|
| 独立数据库/Schema | 无（单一 `licensing` 库） |
| 独立 Redis 命名空间 | 无 Redis |
| 独立签名密钥 | 无（单一 `.keys/`） |
| 独立产品凭证与测试授权 | 无（单一凭证池，种子数据混用） |
| 独立域名/Base URL | 无（只有 `APP_BASE_URL`） |

### 3.7 备份与灾备（规格 16.10–16.12）

| 要求 | 现状 |
|---|---|
| 6 张备份表（destinations/credentials/policies/policy_targets/job_targets/restore_tests） | **0 张** |
| Provider Adapter（Local/S3/WebDAV/SFTP） | **无** |
| 连接测试分阶段（DNS/TLS/认证/目录/上传/下载/校验/删除） | **无** |
| 加密（age/envelope）+ manifest + SHA-256 + `_COMPLETE` | **无** |
| 多目标策略（all_required/primary_then_fallback/quorum） | **无** |
| 恢复演练 + RPO/RTO 记录 | **无** |
| 「系统运维 → 备份与灾备」页面 | **无** |

### 3.8 部署与运维产物

| 要求 | 现状 |
|---|---|
| Dockerfile / docker-compose | **无** |
| `.env.example` | **无**（且现有 `.env` 不可读，受安全策略保护） |
| CI（OpenAPI lint / 契约测试 / Secret 扫描） | **无** |
| 生产启动方式 | 手工 `next start -p 3001` |
| Linux 部署手册对齐（13 章） | 未落地 |

---

## 4. 公开 API 契约逐条对照（现状 vs 规格 OpenAPI）

规范 `openapi-v1.yaml` 共 **10 个 path**，实现 **6 个**：

| # | Path | 规格 | 实现 | 差异 |
|---|---|---|---|---|
| 1 | `POST /activation-challenges` | ✅ | ✅ | 响应缺 `signing_algorithm`；请求 `product_id` 为可选（规格必填） |
| 2 | `POST /activations` | ✅ | ✅ | 见下「字段级差异」 |
| 3 | `POST /activations/heartbeat` | ✅ | ✅ | 认证方式不同（Bearer vs refresh_token） |
| 4 | `POST /activations/deactivate` | ✅ | ✅ | 同上 |
| 5 | `GET /activations/{activation_id}` | ✅ | ❌ | 未实现 |
| 6 | `GET /activations/{activation_id}/entitlements` | ✅ | ✅ | 缺 `entitlements_version` |
| 7 | `POST /licenses/validate` | ✅ | ✅ | 不接受 `product_id`；无限流 |
| 8 | `POST /offline-grants` | ✅ | ❌ | 未实现 |
| 9 | `POST /oauth/token` | ✅ | ❌ | 未实现 |
| 10 | `POST /server/licenses/check` | ✅ | ❌ | 未实现 |

### 4.1 `POST /activations` 字段级差异

| 方向 | 规格字段 | 现状 | 影响 |
|---|---|---|---|
| 请求 | `product_id` | 无（由 `X-Client-ID` 推出） | 兼容：可加可选字段 |
| 请求 | `device.signature` | 顶层 `signature` | **破坏性**：需双读兼容 |
| 请求 | `client.{app_version,sdk_version}` | `client_version` 字符串 | 兼容：可加可选对象 |
| 响应 | `license_id` / `product_id` / `effective_status` / `starts_at` / `expires_at` | 嵌在 `license:{}` 里 | 兼容：扁平字段并列输出 |
| 响应 | `duration{unit,value,label}` | 无 | 补 |
| 响应 | `device_limit{max,active}` / `activation_limit{max,used}` | 无 | 补 |
| 响应 | `refresh_token` / `refresh_token_expires_at` | 无（表 `activation_refresh_tokens` 已建但未接线） | 补 |
| 响应 | `heartbeat_interval_seconds` | 无 | 补（默认 900） |
| 响应 | `access_token_expires_at` | `token_expires_at` | 兼容：两者并存 |

### 4.2 挑战规范化消息

现状（`src/lib/domain/activation-token.ts:83-96`）：

```
{challenge_id}\n{nonce}\n{product_id}\n{device_instance_id}\n{expires_at}
```

规格 27.8：首行必须是 `LICENSE-ACTIVATION-CHALLENGE-V1`，共 6 行。

**这是 P0**：一旦 SDK 发布，字符串就固化在客户端里，改一次等于全网客户端升级。

---

## 5. OpenAPI 一致性结论

- 仓库内**不存在任何 OpenAPI 文件**，因此"OpenAPI 与后端一致"当前不成立（无对象可比）。
- 规格包里的 `openapi-v1.yaml` 是**契约初稿**，与实现有 4 个端点缺失 + 3 个端点字段差异（§4）。
- 按增量指令要求，**不得**把"文件能解析"当成"契约一致"。落地方案：以**当前真实路由/DTO 为唯一事实源**生成 OpenAPI 3.1，再用契约测试逐条打真实请求校验；规格包 yaml 仅作为目标形态参考，差异项写进 `changelog` 与兼容计划。

---

## 6. 安全审计要点

| 项 | 结论 | 证据 |
|---|---|---|
| 生产默认密钥 | 有 `productionSafetyIssues()` 拦截（SESSION_SECRET / HMAC_PEPPER / DEV_MAIL_SINK） | `src/lib/config.ts:47` |
| Secret 落库 | 只存 SHA-256（凭证 secret、webhook secret） | `credentials` / `webhooks` 路由 |
| 私钥 | 仅写 `SIGNING_KEY_DIR/<kid>.pem`，0600，不上传 | `/admin/signing-keys` |
| 授权码 | HMAC + pepper 存 `key_hash`，列表只显示掩码 | `license-key.ts`、`maskLicenseKey` |
| CSRF | 双提交 Cookie（`lic_csrf`）+ 写操作校验 | `src/lib/auth/session.ts`、`guard.ts` |
| 公开 API 限流 | **无** | §3.2 |
| 密钥泄漏（代码内） | 无真实 Secret；仅 dev-only 默认值 | `config.ts` DEV_DEFAULTS |
| `.env` | 存在但被安全策略保护不可读；无 `.env.example` | `ls -a` |

---

## 7. 差距表（P0 / P1 / P2）

### P0 — 不做就无法对外交付（阻断验收）

| ID | 差距 | 现状 | 目标 | 预估 |
|---|---|---|---|---|
| P0-1 | **公开开发者文档中心** | 0 个页面 | `/developers` + 16 子路由，免登录可读、无真实凭证 | 2.5d |
| P0-2 | **OpenAPI 3.1 契约（YAML+JSON）+ 契约测试** | 无文件 | 由真实路由生成、可下载、CI 校验、契约测试逐条通过 | 1.5d |
| P0-3 | **挑战规范化消息加版本前缀** | 5 行 | 6 行（`LICENSE-ACTIVATION-CHALLENGE-V1` 首行）+ 双版本兼容 | 0.5d |
| P0-4 | **激活响应补全 + refresh token 轮换** | 缺 8 字段 | 全字段 + 轮换 + 重放检测（复用 `activation_refresh_tokens`） | 1.5d |
| P0-5 | **公开 API 分层限流** | 无 | 按 client/IP/route 限流 + `RATE_LIMITED` + `Retry-After` + `RateLimit-*` 头 | 1d |
| P0-6 | **`POST /server/licenses/check`** | 无 | 可信服务端凭证 + subject assertion（iss/aud/sub/iat/exp/jti + jti 防重放） | 1.5d |
| P0-7 | **Webhook 真实投递器** | 只有入队 | 签名头 + 5 分钟窗口 + 退避重试 + 死信 + SSRF 防护 + 真实发送测试 | 1.5d |
| P0-8 | **Python / PHP / Node 三语言示例** | 无 | 可运行、覆盖成功与错误、默认 Sandbox、真实请求通过 | 1.5d |
| P0-9 | **Sandbox / Production 隔离** | 无 | 独立 schema + 独立签名密钥 + 独立凭证 + 独立 Base URL + 隔离证据 | 1.5d |
| P0-10 | **多协议异地备份（Local/S3/WebDAV/SFTP）** | 无 | 6 张表 + Adapter + 连接测试 + 加密 + manifest + 完成标记 + 恢复演练 | 3d |
| P0-11 | **备份与灾备页面** | 无 | 目标/策略/作业/恢复演练 + 高风险二次确认 + 审计 | 1.5d |

#### P0-10 / P0-11 落地状态（本轮已完成）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 6 张备份表 | ✅ | 迁移 `20261102120000_v15_public_api_and_backup`；另加 `20261102150000_backup_permissions` 补三个权限码 |
| 四种存储适配器 | ✅ 代码 / ⚠️ 仅 local 端到端验证 | `src/lib/services/backup/adapters/{local,s3,webdav,sftp}.ts`；S3 手写 SigV4，WebDAV 逐级 MKCOL，SFTP 强制 hostKey 指纹。远端目标 `capabilities()` 一律 `false`（未实测不标已支持） |
| 连接测试 | ✅ | `POST /destinations/{id}/test`，分步返回每步 ok/detail 并回写 `last_test_status`；页面上点「测试 …」可复现 |
| 备份包加密 | ✅ | `crypto.ts`：`ZMBK1 + IV(12) + GCM tag(16) + 密文`，单测覆盖往返、随机 IV、篡改一字节即失败 |
| 多目标与状态判定 | ✅ | `decideJobStatus()` 三模式：`all_required` / `primary_then_fallback`（主败备成 → `degraded`）/ `quorum`；单测 6 条 |
| 完整性校验 | ✅ | 上传后下载回来自算 SHA-256 比对；另有 `POST /jobs/{id}/verify` 复算本地暂存 |
| 隔离恢复演练 | ✅ | `POST /jobs/{id}/restore-test`：建临时库 → `pg_restore` → 三条对账（表数 ±2 / 授权行数严格相等 / 关键列完整性）→ 删库；实测 RTO 2–4 秒，41/41 表、245/245 行 |
| 备份与灾备页面 | ✅ | `/app/settings/backups`，五块 + 立即备份 / 连接测试 / 重传 / 校验 / 演练；E2E 4 条 |
| 生产库恢复 | ⛔ 有意不做 | 只做隔离演练；页面顶部明写原因，生产回滚属 P1（需双人确认 + 确认短语 + 不可删除审计） |
| WAL / PITR | ⛔ 未做 | 逻辑备份；页面「目标健康」明写「WAL 归档：未启用」 |
| 定时调度 | ⚠️ 部分 | 策略保存 cron 并校验格式，但没有常驻调度器按时触发；「立即备份」真实可用 |

### P1 — 影响完整度与生态

| ID | 差距 | 目标 | 预估 | 状态 |
|---|---|---|---|---|
| P1-1 | `GET /activations/{id}`、`POST /offline-grants`、`POST /oauth/token` | 补齐 3 端点（离线文件含 `kid`、插件 PKCE） | 1.5d | ✅ 已完成 |
| P1-2 | 心跳/解绑改 refresh token 认证 | 双模式兼容（Bearer 保留） | 1d | ✅ 本就双通道 |
| P1-3 | `entitlements_version` 全链路 | 库字段 + 心跳/权限接口返回 + 变更时自增 | 0.5d | ✅ 已完成 |
| P1-4 | Go / Java / C# 示例 | 标 `Preview`，可运行 | 1d | ✅ 已完成 |
| P1-5 | `llms.txt` / `llms-full.txt` | 跟随文档生成，无泄漏 | 0.5d | ✅ 已完成 |
| P1-6 | 开发者门户用量面板（P95/错误码分布/配额） | 基于 `api_request_logs` 聚合 | 1d | ⏳ 待做 |
| P1-7 | Dockerfile + docker-compose + `.env.example` + CI | 可交付部署产物，CI 跑 OpenAPI/契约/Secret 扫描 | 1.5d | ⏳ 待做 |
| P1-8 | 签名私钥离线备份与恢复流程 | age 加密导出 + 恢复演练 | 0.5d | ⏳ 待做 |

#### P1 已完成项的落地证据

| ID | 证据 |
|---|---|
| P1-1 | `src/app/api/v1/activations/[activation_id]/route.ts`（不可用也返 200，带 `usable`/`status_reason`）、`src/app/api/v1/offline-grants/route.ts`（`license-offline-v1`，签名覆盖 `canonicalJson(grant)`，`valid_until = min(now+grace, 到期时间)`，最长 90 天）、`src/app/api/v1/oauth/token/route.ts`（只收 `private_key_jwt`，显式拒绝 `client_credentials`）。三者已进 `public/openapi/openapi-v1.yaml`（paths 7→10、schemas 11→15），并被 `tests/unit/openapi.test.ts` 正反向覆盖。 |
| P1-2 | `src/app/api/v1/activations/heartbeat/route.ts` 的 `heartbeatWithRefreshToken` 与 `deactivate/route.ts` 的 `deactivateWithRefreshToken` 早已存在，Bearer 通道保留。 |
| P1-3 | `updateLicenseFeatureOverrides()`（`src/lib/services/licenses.ts`）+ `PUT /api/v1/admin/licenses/[id]/features`（`license:issue`，全量替换，空数组即清空回落）+ 详情页「调整功能权限」对话框；集成测试第 12 条断言「管理端改覆盖 → 心跳看到 v2 与新值」。 |
| P1-4 | 六语言可运行示例落在 `sdk-examples/{python,node,php,go,java,csharp}/`，统一 8 类异常 + 基类，`sdk-examples/verify.mjs` 一次跑完并断言成功/失败两条路径（实测 6/6 PASS）。**标 `Preview` 而不是 Stable**：没发布到 PyPI/npm/Packagist/Go proxy/Maven Central/NuGet，按规格 27.17 只能算示例。实测踩出四个平台坑并写进 README：Go/PHP 的 Ed25519 公钥是 32 字节裸钥、服务端要 44 字节 SPKI DER；JDK `HttpClient` 默认 HTTP/2 对明文 `http://` 发 h2c 升级、失败后不回退（`HTTP/1.1 header parser received no bytes`），必须显式 `.version(HTTP_1_1)`；C# 用 Mono + BouncyCastle，`mcs` 需 `-r:System.Net.Http.dll` 且 dll 必须与 exe 同目录。另外把 Python/PHP/Go 三个示例的密钥目录从「假定已存在」改成主动 `mkdir 0700`——自定义 `LICENSE_KEY_DIR` 时它们原本直接崩在 `open()`。 |
| P1-5 | `src/lib/developers/llms-generator.ts`：端点←OpenAPI、错误码←`ERROR_STATUS`、限流←`PUBLIC_RATE_LIMITS`、事件←`WEBHOOK_EVENT_TYPES`、阅读顺序←`DOCS_SECTIONS`；`tests/unit/llms.test.ts` 9 条守派生关系与「无密钥样式」；新增 `docs/ai-integration-prompt.md` + `GET /developers/ai-integration-prompt.md`。 |

### P2 — 可选增强

| ID | 差距 | 预估 |
|---|---|---|
| P2-1 | FTPS / SMB / Google Drive / OneDrive / Dropbox 备份目标 | 2d |
| P2-2 | rsync-over-SSH 第二台 Debian 异地副本 | 1d |
| P2-3 | C++ SDK | 1d |
| P2-4 | 跨云复制 / 自动故障转移 | 2d |
| P2-5 | 离线授权宽限期策略页 | 0.5d |

---

## 8. 兼容方案（保证现有客户端与后台不被打断）

1. **挑战消息**：挑战接口新增 `canonical_version`（`v1`=6 行带前缀，`legacy`=5 行）。服务端按声明版本验签；未声明时先按 legacy 验、失败再按 v1 验。新 SDK 只用 `v1`。
2. **激活请求体**：同时接受顶层 `signature` 与 `device.signature`；同时接受 `client_version` 字符串与 `client{}` 对象。全部新增字段可选。
3. **激活响应**：既有 `license{}`、`token_expires_at`、`token_type` **原样保留**，并列追加规格字段与 `refresh_token`。
4. **心跳/解绑**：`Authorization: Bearer` 与 `{activation_id, refresh_token}` 双通道；Bearer 通道继续签发新 access token，refresh 通道额外做轮换与重放检测。
5. **新端点**：`/server/licenses/check`、`/offline-grants`、`/oauth/token`、`GET /activations/{id}` 为纯新增，不影响现有调用。
6. **数据库**：只做**向前兼容新增**（加表/加列/加索引），不删列、不改语义；迁移前先做一次本地备份脚本演练。
7. **管理后台**：原有页面与全部管理 API 保持不动（现为后台 23 页；v1.5 只新增「备份与灾备」一页，授权详情页新增一个「调整功能权限」对话框），Navigation 只增加「备份与灾备」一个入口（「开发者文档」在 `/developers`，属独立公开站点，不进后台侧栏）。

---

## 9. 实施顺序（第二轮起）

1. 地基：Sandbox 隔离（P0-9）→ 否则文档里的示例无处可跑。
2. 契约：挑战版本前缀（P0-3）→ 激活响应补全（P0-4）→ 限流（P0-5）→ server check（P0-6）。
3. 文档：OpenAPI 生成（P0-2）→ `/developers` 站点（P0-1）→ 三语言示例（P0-8）。
4. 投递：Webhook 投递器（P0-7）。
5. 备份：6 张表 + Adapter（P0-10）→ 备份页面（P0-11）。
6. P1 → P2。

每项完成的判定标准：**有真实代码 + 真实接口 + 真实测试通过**，截图与文档同步更新。

---

## 10. 遗留风险

| 风险 | 说明 |
|---|---|
| 单进程内存限流 | 现有 `rate-limit.ts` 是进程内 Map，多实例部署会失效；P0-5 需落到数据库或 Redis |
| 无后台任务框架 | Webhook 投递器与备份作业都需要调度；当前无 worker，需引入独立进程或 Route Handler + 外部 cron |
| 种子数据混用生产凭证语义 | Sandbox 隔离后需重新划分凭证与授权归属 |
| `.env` 不可读 | 新增变量必须走 `config.ts` 白名单并补 `.env.example`，不能依赖 `.env` |
| 备份目标凭据 | 需 envelope encryption，`backup_storage_credentials` 仅存密文 |
