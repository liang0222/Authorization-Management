# v1.5 运维 Runbook

面向这台机器（[HOST]，Debian 13）上的实际部署。所有命令都在 root 下执行，路径含中文，复制时注意引号。

---

## 1. 部署形态

| 项 | 生产 | 沙箱 |
| --- | --- | --- |
| systemd 单元 | `licensing-saas.service` | `licensing-saas-sandbox.service` |
| 监听 | `127.0.0.1:3100` | `127.0.0.1:3101` |
| `DEPLOYMENT_ENV` | `development`（当前值，见 §7 待办） | `sandbox` |
| 数据库 | `licensing` | `licensing_sandbox` |
| 签名私钥目录 | `.keys/` | `.keys-sandbox/` |
| 本地备份目录 | `.backups/` | `.backups-sandbox/` |
| 凭证池 | `product_credentials.environment = production` | `= sandbox` |
| 限流命名空间 | `development:`（随 DEPLOYMENT_ENV） | `sandbox:` |
| 环境文件 | 无（`Environment=` 写在单元里） | `/etc/licensing-saas/sandbox.env`（0600） |

两个实例共用同一份代码目录、同一个 Node 进程二进制、同一个 PostgreSQL 容器（`licensing-pg`，`127.0.0.1:55432`），但数据库、密钥、备份目录、凭证池、限流命名空间全部隔离。

**不要碰**：80/443 的 `1Panel-openresty-91lk`、13331 的 `dsh-web.service`、`/root/.dsh`。

---

## 2. 日常操作

```bash
# 状态
systemctl status licensing-saas licensing-saas-sandbox
ss -ltnp | grep -E ':3100|:3101'

# 日志（只看本次启动之后的错误）
journalctl -u licensing-saas --since "-10min" -p warning
journalctl -u licensing-saas-sandbox -n 100 --no-pager

# 重启（改代码后必须重新 build，见 §3）
systemctl restart licensing-saas licensing-saas-sandbox

# 健康检查（注意：本项目没有 /api/health）
curl -s http://127.0.0.1:3100/api/v1/status | head -c 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/login
```

启动日志里应能看到两行 worker 常驻：

```
[webhook] dispatcher started, interval=5000ms
[backup] scheduler started, interval=30000ms
```

`[boot] … 配置检查未通过` 表示用了开发默认密钥。生产实例目前是 `development` 环境，只告警不阻断；改成 `production` 后会**直接抛错拒绝启动**（`Restart=on-failure` 会一直重试并在日志里留原因）。

---

## 3. 发布流程（改代码之后）

```bash
cd /root/授权saas
npm run typecheck                       # 必须 0 错误
npm run lint:openapi                    # 契约 lint，必须通过
npm run test                            # 单测
npm run build                           # next build
systemctl restart licensing-saas licensing-saas-sandbox
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/login   # 期望 200
```

数据库结构变更：

```bash
npx prisma migrate deploy
```

**没有 `db:push`**：新增列/表必须手写 `prisma/migrations/<时间戳>_<名字>/migration.sql`，与 `schema.prisma` 一起提交。已应用的 7 条迁移见 `prisma/migrations/`。

---

## 4. 备份

### 4.1 自动备份

`src/lib/services/backup/scheduler.ts` 每 30 秒扫一次 `backup_policies`，按 `schedule_cron` + `timezone` 判断是否到点，用 PostgreSQL advisory lock 保证多实例只有一个真的跑。策略在后台「系统设置 → 备份与灾备」里配置。

每条策略可以挂多个目标（local / S3 兼容 / WebDAV / SFTP），目标模式 `all_required`（任一失败整体失败）、`primary_then_fallback`（主失败、备成功 → `degraded` 并告警）、`quorum`。

每目标状态：`queued → uploading → uploaded → verifying → verified`，失败为 `failed`，未参与为 `skipped`。只有 `verified` 才算备份成功。

### 4.2 加密

备份文件是信封加密的（魔数 `ZMBK1` + IV + GCM tag），密钥来自 `BACKUP_ENCRYPTION_KEY`。**没有这个密钥，备份文件无法恢复**。它必须与备份文件分开保管。

### 4.3 恢复演练

后台「备份与灾备 → 作业」里对某个作业点「恢复演练」，服务端会：

1. `createdb licensing_restore_<随机后缀>`；
2. `pg_restore` 到临时库；
3. 三项对账：表数量（±2）、`licenses` 行数（必须相等）、`license_keys` 关键列完整性（异常行必须为 0）；
4. `dropdb` 清理。

全程不碰生产库。演练结果记在 `backup_restore_tests`。

### 4.4 真灾备恢复（手工）

```bash
# 1) 取回备份文件（任意一个 verified 目标）
# 2) 校验完整性
sha256sum bkp_*.zmbk          # 与作业记录里的 manifestSha256 比对

# 3) 解密（Node 侧实现，用项目的 crypto.ts；口令是 BACKUP_ENCRYPTION_KEY）
# 4) 恢复到新库 → 对账 → 切换 LICENSE_DB_URL → 重启
```

切换前务必先在临时库上跑一次对账，不要直接覆盖生产库。

---

## 5. 签名私钥离线备份

```bash
/root/授权saas/scripts/offsite-key-backup.sh
```

产物在 `/root/授权saas-offsite/`（0700）：

- `keys-<UTC>.tar.gz.enc`：`.keys/` 全量，AES-256-CBC + PBKDF2（iter=200000）；
- `signing-keys-<UTC>.sql`：`signing_keys` 的元数据（kid/status/private_key_ref/public_key_hex/not_after），**不含私钥**；
- `MANIFEST-<UTC>.txt`：sha256 清单 + 恢复步骤。

口令在 `/etc/licensing-saas/offsite-passphrase`（0600），**不在归档里**，必须另外抄一份到密码管理器/纸质保险柜。丢了口令 = 归档作废。

脚本自带自检：解密 → 解包 → 逐文件比 sha256，17 个文件全一致才算成功。

恢复：

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in keys-<UTC>.tar.gz.enc -out /tmp/keys.tar.gz \
  -pass file:/etc/licensing-saas/offsite-passphrase
mkdir -p /root/授权saas/.keys && tar -xzf /tmp/keys.tar.gz -C /root/授权saas/.keys
chmod 600 /root/授权saas/.keys/*.pem
# 逐文件比对 MANIFEST 里的 sha256，再重启
```

`GET /api/v1/admin/signing-keys` 只返回公钥指纹与私钥文件名，**不提供私钥下载**；私钥一旦泄露必须走「轮换签名密钥」。

---

## 6. 沙箱

```bash
# 重建沙箱库（会清空沙箱数据，生产不受影响）
/root/授权saas/scripts/sandbox-bootstrap.sh          # 幂等
RESET=1 /root/授权saas/scripts/sandbox-bootstrap.sh  # 删库重建

# 隔离自检：四组必须符合预期
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3101/api/v1/licenses/validate \
  -H 'content-type: application/json' -H 'x-client-id: pc_desktop_7d3c1a9b4e2f' \
  -d '{"license_key":"AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA"}'     # 期望 401
```

沙箱客户端 ID 形如 `pc_sandbox_*` / `cs_sandbox_*`，与生产 ID 不可互换。凭证在哪个环境创建就属于哪个环境，`environment` 列由服务端强制，前端不能选。

---

## 7. 回滚

### 7.1 代码回滚

非 git 仓库，回滚靠备份目录：

```bash
ls -la /root/授权saas/.backups/
```

**建议尽快 `git init` 并打 tag**，否则每次发布都无法精确回退。当前没有版本历史是本项目最大的运维风险。

### 7.2 数据库回滚

Prisma 迁移只前进不回退。回滚方式：

```bash
systemctl stop licensing-saas licensing-saas-sandbox
docker exec -i licensing-pg pg_restore -U licensing -d licensing \
  --clean --if-exists --no-owner < <回滚点备份>
systemctl start licensing-saas licensing-saas-sandbox
```

⚠️ 恢复旧 dump 会**删掉新版本加的表和列**（例如 `product_credentials.environment`），恢复后必须把代码也回退到匹配版本，否则应用起不来。

### 7.3 待办（上生产前必须做）

1. 生产实例 `DEPLOYMENT_ENV` 仍是 `development`。改成 `production` 之前，必须先把 `SESSION_SECRET`、`LICENSE_HMAC_PEPPER`、`BACKUP_ENCRYPTION_KEY` 换成强随机值、`DEV_MAIL_SINK=false`，否则启动即失败（这是设计如此，防止生产用开发密钥）。
2. `git init` + 首次提交 + tag `v1.5.0`。
3. 把 openresty 反代到 3100（目前只在回环上，外网不可达）。
4. 每日异地备份目标落到真实的对象存储；当前只验证过本机临时容器。

---

## 8. 常见故障

| 现象 | 排查 |
| --- | --- |
| 启动即退出，日志有 `[boot] … 不能与生产共用` | 沙箱实例的 `SIGNING_KEY_DIR` / `BACKUP_LOCAL_DIR` 与生产重名，改独立目录 |
| 登录 401 且返回 `mfa_required: true` | 该账号开了 MFA，登录要带 `totp` |
| 公开接口 401 `CLIENT_AUTH_FAILED` | `X-Client-ID` 不存在、已停用，或**用错了环境**（沙箱 ID 打生产/反之） |
| 公开接口 429 `RATE_LIMITED` | 看响应头 `Retry-After`；限额定义在 `src/lib/domain/public-rate-limits.ts` |
| 备份目标连接测试失败 | 看 `last_test_error_code`；SFTP 注意 host key 指纹、目录属主；WebDAV 生产必须 https |
| Webhook 一直 `dead` | 看 `webhook_deliveries.last_error`；4xx 直接判死，SSRF 拦截也直接判死（`blocked_url:`） |
| 页面 404 但接口正常 | 检查 `src/lib/domain/permissions.ts` 的导航与页面文件是否都在 |
