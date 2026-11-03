# v1.5 增量交付报告

基线：`docs/v15-audit.md`（第一轮审计，2026-11-02）＋ 规格包 `licensing_saas_v1.5_complete_public_api_package`。
本轮原则：**只增量补全，不推翻重写**；每一项都必须有真实代码 + 接口 + 测试 + 真跑证据。

---

## 1. 已闭合的 P0

| 编号 | 项 | 实现位置 | 证据 |
| --- | --- | --- | --- |
| P0-1 | 公开开发者文档中心（27.2 的 20 个路由） | `src/app/developers/**`、`src/lib/developers/**` | 20 个路由免登录全部 200；`/developers` 63KB、`/developers/api-reference` 120KB；无 TODO/占位文案 |
| P0-2 | OpenAPI 与真实路由一致（27.18 / 27.20） | `public/openapi/openapi-v1.yaml|json`、`tests/unit/openapi.test.ts` | paths 与规格包 10/10 一致；双向核对（spec→route.ts、route.ts→spec）；新增 `npm run lint:openapi` 守 schema/servers/凭证泄漏/YAML-JSON 同步 |
| P0-3 | 挑战规范化消息带版本前缀（27.8） | `src/lib/domain/activation-token.ts` | `CANONICAL_CHALLENGE_PREFIX = "LICENSE-ACTIVATION-CHALLENGE-V1"`，6 行格式，v1/legacy 双版本；单测覆盖 |
| P0-4 | 激活响应字段 + refresh token 轮换 | `src/lib/services/activations.ts`、`activations/{heartbeat,deactivate}` | 响应含 18 个字段（含 `entitlements_version`、`refresh_token_expires_at`）；心跳/解绑优先 refresh_token 并作废旧令牌 |
| P0-5 | 公开 API 限流（27.6） | `src/lib/domain/public-rate-limits.ts`、`src/lib/services/rate-limit-store.ts` | 按端点族分档（challenge 30、activate 10、heartbeat 60…）；PostgreSQL 原子 UPSERT，返回 `RateLimit-*` / `Retry-After`，429 `RATE_LIMITED` |
| P0-6 | 服务端校验端点 | `src/app/api/v1/server/licenses/check`、`offline-grants`、`oauth/token`、`activations/[activation_id]` | 四个 v1.5 新端点全部落地并有集成测试 |
| P0-7 | Webhook 投递器（签名/重试/死信） | `src/lib/services/webhook-dispatcher.ts` | `X-License-Signature: v1=HMAC(timestamp.body)`；6 次退避 `[30,120,480,1920,7200]`；4xx 直接 dead；`FOR UPDATE SKIP LOCKED` 领取 |
| P0-7b | **Webhook SSRF 防护** | `src/lib/domain/outbound-url.ts`、`outbound-http.ts` | 建端点时拒绝私网/元数据段；投递时 `safeLookup` 解析后逐 IP 校验、不跟随重定向、`agent:false`。实测 10.0.0.0/8、192.168/16、169.254.169.254、非回环 http 全部 400 |
| P0-8 | 六语言接入示例（27.7） | `sdk-examples/{python,node,php,go,java,csharp}` | 默认值已清空真实 client_id；`python -m py_compile` / `node --check` 通过；README 标注 Preview 与实测坑 |
| P0-9 | Sandbox / Production 真隔离（27.3） | `deployment-environment.ts`、`licensing-saas-sandbox.service`、`scripts/sandbox-bootstrap.sh` | 独立库 `licensing_sandbox`、独立 `.keys-sandbox`、独立 `.backups-sandbox`、独立凭证池（`environment` 列）、独立限流命名空间。四组交叉验证全部符合预期 |
| P0-10 | 多协议异地备份（16.11） | `src/lib/services/backup/**` | Local/S3/WebDAV/SFTP 四个适配器真连通过；三目标同一份备份 sha256 全等；`verify` 与 `restore-test` 全绿 |
| P0-11 | 备份与灾备后台页 | `src/app/app/settings/backups/page.tsx` | 目标/策略/作业/演练四个页签齐备；策略返回 `scheduleText` 与 `nextRunAt` |
| P0-12 | **备份定时调度器** | `src/lib/services/backup/scheduler.ts` | 30s tick + advisory lock；实测把 cron 改 `* * * * *` 后 35s 内生成 `trigger:"scheduled"` 作业，改回后不再触发 |
| P0-13 | **备份失败告警** | `src/lib/services/backup/alerts.ts` | 审计 `backup.job_failed` / `backup.schedule_skipped` + `console.error` + 可选 `BACKUP_ALERT_WEBHOOK_URL`；另含本地磁盘水位检查 |
| P0-14 | **签名私钥离线恢复材料** | `scripts/offsite-key-backup.sh`、`docs/v15-runbook.md` §5 | 归档 AES-256-CBC + PBKDF2(200k)，自检解密后 17 个文件 sha256 全一致；口令与归档分离存放 |
| P0-15 | 启动安全闸门 | `src/instrumentation.ts` | `productionSafetyIssues()` 真正被调用；production 有致命配置问题直接 throw；sandbox 共用 `.keys`/`.backups` 也报错 |

## 2. 已闭合的 P1

| 编号 | 项 | 实现位置 |
| --- | --- | --- |
| P1-1 | 游标分页（27.5） | `src/lib/domain/cursor.ts`、`src/lib/http/api.ts`、14 个列表端点 |
| P1-2 | 设备详情页 | `src/app/app/devices/[id]/page.tsx` |
| P1-3 | 角色与权限页 | `src/app/app/settings/roles/page.tsx` + 导航项 |
| P1-4 | Webhook 测试投递 | `webhooks/[id]/test` 路由 + 端点页按钮 |
| P1-5 | OpenAPI lint / CI | `scripts/openapi-lint.mjs`、`npm run lint:openapi`、`.github/workflows/ci.yml` |
| P1-6 | 容器化 | `Dockerfile`（多阶段，非 root，HEALTHCHECK 打 `/api/v1/status`）、`docker-compose.yml`、`.dockerignore` |
| P1-7 | 运维 Runbook | `docs/v15-runbook.md`（部署、发布、备份、恢复、回滚、故障排查） |
| P1-8 | 文档无真实凭证（27.19） | 文档页与 SDK 全部改占位符；`sdk-examples/python/__pycache__` 已清理 |

## 3. 仍缺（P1 / P2）

| 编号 | 项 | 现状 | 建议 |
| --- | --- | --- | --- |
| P1-9 | 生产实例仍是 `DEPLOYMENT_ENV=development` | 生产用开发默认密钥也能跑，只告警 | 上生产前换密钥 + 改 `production` + 验证启动通过 |
| P1-10 | 无版本控制 | 非 git 仓库，`npm ci` 与回滚都没有基线 | `git init` + 首次提交 + tag `v1.5.0` |
| P1-11 | ESLint 存量 48 错 | 全是 `react-hooks/*`（React Compiler 规则）与 1 个 `any` | CI 里 `continue-on-error`，不掩盖；逐页重构再收紧 |
| P1-12 | 游标仍是签名 offset | 深翻页仍随 offset 增大而变慢 | 改 keyset（需逐表定义稳定排序键 + tie-breaker） |
| P1-13 | PHP/Go/Java/C# 示例本机未编译 | 本机无 php/go/javac/mcs | 在 CI 矩阵里补四个语言 job |
| P1-14 | 备份只验证过本机临时容器 | S3/WebDAV/SFTP 容器已删除 | 上线前对真实异地存储再跑一遍连接/上传/下载/演练 |
| P2-1 | FTPS / SMB / 云盘 / rsync / C++ SDK | 未实现 | 按 16.11.1 / 27.7 排在 P2 |

## 4. 本轮修复的真实缺陷（不是新功能）

1. **备份凭证解密必然失败**（`src/lib/services/backup/factory.ts`）——写入时存的是 base64 字符串的 UTF-8 字节，读取时又做了一次 base64 解码，GCM 校验永远过不去。报错：`Unsupported state or unable to authenticate data`。这是 S3/WebDAV/SFTP 全链路不可用的根因。
2. **`root_path` 被静默丢弃**——SFTP 填 `/upload` 实际写进账号根目录。新增 `joinRemotePrefix()`。
3. **WebDAV 对已存在目录 MKCOL 返回 409 时误判失败**——改为 201/405/409 都算可用。
4. **`productionSafetyIssues()` 从未被调用**——生产可以用开发默认密钥启动。已接进 `src/instrumentation.ts`。
5. **备份策略 UI 宣称"到点自动执行"但没有调度器**——已补调度器，文案与实现现在一致。

## 5. 验证摘要（可复跑）

```bash
cd /root/授权saas
npm run typecheck        # 0 错误
npm run lint:openapi     # 通过
npm run test             # 12 files / 131 tests
npm run build            # 成功
systemctl restart licensing-saas licensing-saas-sandbox
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/login                      # 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/v1/status              # 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3101/api/v1/licenses/validate \
  -H 'content-type: application/json' -H 'x-client-id: pc_desktop_7d3c1a9b4e2f' \
  -d '{"license_key":"AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA"}'                              # 401（隔离生效）
```

## 6. 数据现状

生产库 `licensing`：organizations=1、customers=14、products=4、license_keys=232、activations=444。
`audit_logs` / `api_request_logs` 因本轮真实操作而增长（登录、备份、删除测试配置都会写审计），这是审计日志的正常行为，不做回滚——它们是"这些操作真的发生过"的证据。

沙箱库 `licensing_sandbox`：独立种子（240 份授权、3 条 sandbox 凭证）。

测试残留：2 条备份作业（`bkp_20261103041917…`、`bkp_20261103052314…`）与 1 条恢复演练记录保留作为真跑证据；对应的目标与策略已删除，可在后台「备份与灾备」里手动清理。

---

## 补充：文档与运维缺口（2026-11-03 补齐）

| 项 | 状态 | 文件 |
| --- | --- | --- |
| 变更记录 / Release Note | ✅ | `CHANGELOG.md` |
| 漏洞报告流程与安全边界 | ✅ | `SECURITY.md` |
| 发布管理 / 容量 / 事件响应 / 状态页（规格 23） | ✅ | `docs/operations.md` |
| 可观测性、健康检查、告警分级（规格 18） | ✅ | `docs/observability.md` |
| 数据隐私与保留（规格 17.5） | ✅ | `docs/privacy.md` |
| 环境变量模板（规格 13） | ✅ | `.env.example`（旧 `env.example` 已更名） |
| README 文档索引与路由计数 | ✅ | `README.md` §3.1 / §6 |

仍未实现（明确记录，不假装完成）：

- 登录异常与跨租户越权的实时告警（只有备份链路的告警）；
- 日志保留期的自动清理任务（需外部 cron）；
- 状态页的维护公告后台（`/developers/status` 只显示聚合指标）；
- 会话列表与「撤销其他设备」界面（改密会撤销其他会话，但没有独立入口）；
- WAL/PITR 与月度自动恢复演练。
