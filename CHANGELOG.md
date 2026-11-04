# 变更记录

本文件记录每一次对外可见的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布规则（规格 23.1）：生产发布只使用不可变 Git Tag，不跟随 `latest`；每次发布在本文档记录
Release Note、commit、迁移 ID 与回滚方式。

---

## [Unreleased]

### 新增 · 开发者文档

- **在线 OpenAPI 浏览页** `/developers/openapi`：Scalar standalone 渲染 OpenAPI 3.1（左侧目录 / 中间说明 /
  右侧示例，Ctrl-K 搜索，界面中文）。数据源是同源 `/developers/openapi.yaml`，页面上的 Base URL 就是本实例
  真实域名。构建时由 `scripts/copy-api-reference.mjs` 把 IIFE 版脚本复制到 `public/vendor/`（不进 git）。
  按 27.2 关闭了交互式请求按钮（`hideTestRequestButton`）。文档侧栏新增「在线 API 浏览」入口。
- 新增 `/openapi` → `/developers/openapi` 的 307 临时跳转，方便外部按最直白的路径命中在线文档。

### 新增 · 部署

- **`scripts/deploy-bootstrap.sh`**：一条命令把解包后的目录变成 systemd 管着、健康检查通过的实例。
  十步幂等：前置检查 → 生成环境文件（缺 `LICENSE_DB_URL` 会补并告警，不静默回退）→ 可选起 PG 容器 →
  可选恢复 dump → `npm ci` + `prisma generate` → `prisma migrate deploy` → 私钥体检与补齐 →
  `npm run build` → 写 systemd 单元 → 真验证（`/health/ready` + `/login` + `/` + journal 错误计数）。
  支持 `--only=build|systemd`、`--skip-db`、`--port`、`--bind`、`--env-file`、`--service-name`（部署第二实例）。
- **`scripts/repair-signing-keys.mts`**：从 dump/备份恢复后补齐「库里有记录、磁盘上没有」的私钥。
  默认 DRY-RUN，`--apply` 才写。给 `signing_keys` 缺失行重新生成 Ed25519 密钥对（新行继承原行 `status` 与
  时间窗），给 confidential_server 凭证补 `credentials/{client_id}.pem` 并同步更新库中公钥。幂等，末尾对
  「多条 active」告警。

### 修复 · 部署

- **`/health/ready` 探测过浅**：原来只数 `signing_keys` 里 `status='active'` 的行 + 检查密钥目录可读，
  私钥文件不在盘上时仍返回 200。现在会顺着当前 active 行的 `private_key_ref` 找到具体 `.pem` 并 `access`，
  失败返回 503 `signing_key_unreadable`（原 `signing_key_dir_unreadable` 不再产生）。这样「从备份恢复但没补
  私钥」会在重启后立刻暴露，而不是等到第一次签发授权才 503。
- 文档 §4.4 记录两个必踩的坑：恢复 dump 后必须 `prisma migrate deploy`（否则 42703「列不存在」）、
  必须补签名私钥（否则 ready 过了但签发 503）；§10 新增 10.6b「签发链路真的能签」验收步骤。

## [1.5.0] - 2026-11-03

### 新增 · 公开 API 协议

- **挑战规范化消息固定 6 行**，首行为 `LICENSE-ACTIVATION-CHALLENGE-V1`；同时保留 `legacy` 版本兼容旧客户端
  （`src/lib/domain/activation-token.ts`）。
- **激活响应补齐**：`activation_id`、`license_id`、`product_id`、`effective_status`、`starts_at`、`expires_at`、
  `duration`、`device_limit`、`activation_limit`、`entitlements`、`entitlements_version`、`access_token`、
  `refresh_token`、`heartbeat_interval_seconds`；v1.4 的 `token_type` / `license` 字段继续返回。
- **refresh token 轮换**：心跳与解绑优先接受 `refresh_token`，每次使用后旧令牌立即失效；Bearer 通道保留兼容
  （`src/app/api/v1/activations/{heartbeat,deactivate}/route.ts`）。
- **`entitlements_version` 全链路**：授权功能覆盖变更时自增，客户端据此判断是否需要重新拉取权限。
- **新增端点**：`GET /api/v1/activations/{id}`、`POST /api/v1/server/licenses/check`、
  `POST /api/v1/offline-grants`、`POST /api/v1/oauth/token`。
- **公开 API 限流**：按端点族分级（挑战 30/60s、激活 10、心跳 60、解绑 10、权限 120、校验 30、服务端检查 120、
  离线授权 10、OAuth 60、默认 120），PostgreSQL 原子固定窗口，返回 `RateLimit-*` 与 `Retry-After`。
- **幂等**：写操作识别 `Idempotency-Key`，同体重放返回首次结果，不同体返回 409。

### 新增 · 开发者文档中心

- `/developers` 及 15 个子页（快速开始、核心概念、认证、API 参考、SDK、四个平台接入、Webhook、错误码、
  限流、变更记录、Sandbox、状态页），全部免登录可读。
- 机器可读产物：`llms.txt`、`llms-full.txt`、`openapi.yaml`、`openapi.json`，全部由代码派生，
  单测守住“路径/错误码/限流/事件类型必须来自唯一事实源”（`tests/unit/llms.test.ts`）。
- 六语言接入示例（Python / PHP / Node / Go / Java / C#），统一标注 **Preview**，不谎称已发布 SDK。

### 新增 · 备份与灾备

- 四类存储适配器：Local、S3 Compatible（自实现 SigV4）、WebDAV over HTTPS、SFTP（强制校验 host key 指纹）。
- 多目标策略：`all_required` / `primary_then_fallback` / `quorum`；每目标独立状态
  `queued`/`uploading`/`uploaded`/`verifying`/`verified`/`failed`/`skipped`，总体状态
  `succeeded`/`degraded`/`partial`/`failed`，不会把部分成功报成完全成功。
- 信封加密（`ZMBK1`，AES-256-GCM）、manifest + SHA-256、上传后回读校验、完成标记。
- **后台调度器**：每 30 秒扫描到期策略，`pg_try_advisory_lock` 保证多实例下只有一个执行者，
  同一分钟不重复跑（`src/lib/services/backup/scheduler.ts`）。
- **隔离恢复演练**：用真实 `createdb` + `pg_restore` + 行数/表数对账 + `dropdb`，产出 RTO 实测值。
- **告警**：作业失败、配置缺失、本地磁盘余量不足时写 `audit_logs` 并输出结构化告警日志，
  可配置 `BACKUP_ALERT_WEBHOOK_URL` 外发。

### 新增 · Sandbox / Production 隔离

- `product_credentials.environment` 列（`production` / `sandbox`），跨环境调用一律按无效处理。
- 独立沙箱实例：`licensing_sandbox` 库、`.keys-sandbox/`、独立限流前缀、独立备份目录，
  systemd 单元 `licensing-saas-sandbox.service` 监听 `127.0.0.1:3101`。

### 新增 · 安全

- **Webhook SSRF 防护**：建端点与投递时都校验目标地址，拒绝私网段、链路本地（含云元数据）、
  CGNAT、IPv6 ULA/链路本地，DNS 解析后逐 IP 复核，不跟随重定向（`src/lib/domain/outbound-url.ts`）。
- **启动安全闸门**：生产环境使用开发默认密钥、共用开发签名目录等直接拒绝启动
  （`src/instrumentation.ts` + `productionSafetyIssues()`）。
- **密钥轮换**：`SECRETBOX_KEY` 密钥环（新密钥写入、旧密钥只读解密）与 `LICENSE_HMAC_PEPPER` 版本环
  （旧 pepper 命中后就地重哈希），配套 `scripts/rotate-secrets.mts` 一次性重封存脚本。
- **分层健康检查与指标**：`/health/live`、`/health/ready`、`/metrics`（Bearer 令牌 + 反代层 deny）。
- **HTTPS**：`<你的域名>` 由 openresty 提供 443（HTTP/2 + TLSv1.2/1.3 + HSTS），
  80 端口在 ACME 挑战路径之外全量 301 到 https；`/metrics` 在反代层直接 403。

### 新增 · 管理后台

- `/app/devices/[id]` 设备详情（档案 / 绑定记录 / 事件时间线）。
- `/app/settings/roles` 角色与权限（查看预设角色、创建自定义角色）。
- Webhook 详情页「发送测试事件」，同步返回投递结果与耗时，接收端可核对 `X-License-Signature`。
- 列表接口支持 **cursor 分页**：`page.next_cursor` / `has_more`，游标 HMAC 签名并绑定请求路径，
  旧 `page` / `pageSize` 继续可用。

### 变更

- 备份策略列表新增 `scheduleText`（人类可读的调度描述）与 `nextRunAt`（下次预计执行时间）。
- 公开文档与示例代码不再写死真实 Client ID，统一改为 `<your-client-id>` 占位符。

### 新增

- 备份目标新增**真正异地**的第五个目标 `offsite-webdav-remote`（`http://[OFFSITE_HOST]:5244/dav`，rootPath `/film`，prefix `ziming-license-backups`），`daily-production` 策略改为五目标 `all_required`；作业 `bkp_20261103131555_e2c918` 五份 sha256 全等 `5c521157…08f3`，并从公网独立下载该字节解密恢复（41 表 / 240 授权行对账通过）。

### 修复

- **备份存储凭证解密失败**：`parseCredential()` 对已封存密文做了二次 base64，导致 GCM 校验必然失败
  （报错 `Unsupported state or unable to authenticate data`）。这是 S3 / WebDAV / SFTP 连接测试
  全部失败的根因。
- **远端根路径被忽略**：SFTP / WebDAV 配置的 `root_path` 未参与拼接，文件被写到账号根目录。
- **远端路径前缀被拼两次**：`remote_prefix` 在 runner 与适配器里各拼一次，SFTP 目标落成
  `…/upload/backups/offsite/backups/offsite/bkp_*.zmbk`，WebDAV 同样；连接测试的探针文件也受影响。
  现在由 `backupObjectKey()`（`src/lib/services/backup/runner.ts`）统一产出对象键，适配器只负责
  `root_path`，并补了 4 条防回归单测。
- **WebDAV 适配器硬拒非 loopback 的 `http` 端点**：原实现要求端点必须是 https，只有 `localhost/127.0.0.1/::1`
  才能放行 http，导致「接外部只监听 http 的自建对象存储（AList `/dav`）」在技术上进不去。改为
  **仅在目标未显式设 `tlsVerify=false` 时拒绝**：操作者在目标配置里关掉校验，等于明确承担明文风险。
  注意这是真的明文——Basic Auth 与备份字节都原样过网（备份体本身是 `ZMBK1` AES 加密信封，内容不泄露，
  但用户名密码可被链路中间人截获）；要消除需给该端点配 HTTPS 后改回默认。
- **生产环境 WebDAV 无法使用内网端点**：`allowInsecureHttp` 原先只看 `deploymentEnv`，导致显式
  `tlsVerify=false` 的内网/本机端点也被拒绝。现在 `tlsVerify=false` 即可放行，但适配器自身的
  非 loopback 明文检查仍然生效，公网 http 依旧进不来。
- **WebDAV 目录已存在时误判失败**：`MKCOL` 返回 409（父目录已存在）现在视为可用；另外 Apache
  （`bytemark/webdav` 就是）对「已存在的集合 + 无尾斜杠」会连 `MKCOL` 一起 301 到 `<path>/`，
  由于适配器是 `redirect: "manual"`（防止把 Basic Auth 带去别的主机），这类重定向以前被判成
  `UPLOAD_FAILED`。现在只有「同源 + 路径就是自己加一个尾斜杠」的 301/308 才被视为目录已存在，
  跨主机或跨路径的跳转仍然失败（`isSameOriginTrailingSlashRedirect`，附 4 条单测）。
- 容器内 `SIGNING_KEY_DIR=/app/.keys` 被安全闸门误判为“与开发共用”，改为规范化路径比较。

### 已知限制

- 未启用 WAL / PITR，最大数据丢失窗口为“距上一次成功备份的时间”（默认每日一次）。
- `/metrics` 未接入任何现成监控系统，需要自行配置 Prometheus 抓取。
- C++ / 浏览器插件 / 小程序只提供接入说明，不提供可发布 SDK。

---

## [1.4.x] 及更早

v1.5 之前的历史未纳入本文件，详见 `docs/handoff.md` 与 git 历史（仓库自 v1.5.0 起初始化）。
