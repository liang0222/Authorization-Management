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

# 分层健康检查（本项目没有 /api/health）
curl -s http://127.0.0.1:3100/health/live     # 只测进程
curl -s http://127.0.0.1:3100/health/ready    # 测库与签名密钥，失败 503
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3100/metrics | head
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

**当前生产配置**（2026-11-03 建，四目标全 `isRequired`）：

| 目标 | 类型 | 落点形态 | 连接测试 |
| --- | --- | --- | --- |
| `local-primary` | `local` | `file:///root/授权saas/.backups/backups/production/bkp_*.zmbk` | 写入 / 读回 / 删除 三步 ok |
| `offsite-s3` | S3 兼容 | `s3://licensing-offsite/backups/offsite/bkp_*.zmbk` | 上传 / 下载比对 / 删除 ok |
| `offsite-sftp` | SFTP | `sftp://127.0.0.1:19022/upload/backups/offsite/bkp_*.zmbk` | 连接与**主机指纹**校验 / 建目录 / 上传 / 下载比对 / 删除 五步 ok |
| `offsite-webdav` | WebDAV | `http://127.0.0.1:19080/backups/offsite/bkp_*.zmbk` | Basic Auth / 上传 201 / 下载比对 SHA-256 / 删除 204 四步 ok |

策略 `daily-production`：`0 3 * * *` / `Asia/Shanghai` / `all_required` / `sha256_and_manifest` / 加密开 / 保留 7 日 + 4 周 + 3 月。

> ⚠️ **这四个目标全部跑在本机 Docker 容器里**（`licensing-offsite-s3`、`licensing-offsite-sftp`、`licensing-offsite-webdav`），属于**同机冗余**，不是跨机房异地。它验证的是"多协议上传、校验、恢复链路都能跑通"，**不解决整机或整盘损毁**。
>
> 真正满足规格 24 的"自动上传独立异地存储"，需要把上面任一目标改填**外部**端点（云对象存储的 endpoint/bucket/access_key，或异地主机的 SFTP/WebDAV 地址与凭据）：在后台「备份与灾备 → 目标」里编辑该目标，换掉 `endpointUrl` 与凭据即可，`remotePrefix` 与策略无需改动。生产下 WebDAV 只允许 `https`（除非显式 `tlsVerify=false` 且主机是 loopback）。

实跑证据（2026-11-03，作业 `6f8233d0-32ab-48da-8ea9-274c2431956d` / `bkp_20261103125355_e47bd4`，306579 B）：四目标 `status` 全 `verified`，`checksumSha256` 四份全等 `d74fb0ea…2d7e`；容器内各自 `sha256sum` 与文件头 `ZMBK1` 魔数均已复核；`verify` 返回 `expected == actual`；`restore-test` 四项对账全 ✅（41 表 / 240 授权行 / 异常行 0，RTO 1s）。

更早一轮（作业 `61b274da-…` / `bkp_20261103124458_30ceb3`）还做过一次**独立解密恢复**：从 **S3 远端那份字节**取出（303831 B，sha256 `c61244fd…39c4`），按 `src/lib/services/backup/crypto.ts` 的真实格式解密（`ZMBK1` → `PGDMP`，303798 B）后 `pg_restore` 到临时库：41 张表，organizations=1 / customers=14 / products=4 / licenses=240 / license_keys=232 / activations=444 全部与生产一致（`audit_logs` 差 3 行为备份后的正常增量），`key_hash` 前三条逐字节相同 → 同一 pepper 下授权码仍可验签。这条证明了「远端那份文件本身可用」，而不只是「哈希相等」。

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

### 7.3 已完成的上生产项（2026-11-03）

1. ✅ 生产实例 `DEPLOYMENT_ENV=production`，`SESSION_SECRET` / `SECRETBOX_KEY` /
   `LICENSE_HMAC_PEPPER` / `BACKUP_ENCRYPTION_KEY` 全部换为随机值，`DEV_MAIL_SINK=false`，
   `SIGNING_KEY_DIR=.keys-prod`；启动日志 `[boot] env=production … 配置检查通过`。
   旧 pepper 留作 `LICENSE_HMAC_PEPPER_LEGACY`（版本环），旧封存密钥在重封存后已移除。
2. ✅ `git init` + 首次提交 + tag `v1.5.0`。
3. ✅ openresty 反代到 3100（`<你的域名>`，HTTP）。**HTTPS 待办**：需在 1Panel
   为 `<你的域名>` 申请证书后，在 `/opt/1panel/www/conf.d/<你的域名>.conf`
   增加 443 server 并复用同一 `location` 段。
4. ⚠️ 每日异地备份目标仍需落到真实对象存储：本机只验证过临时容器（S3/WebDAV/SFTP 三协议均
   `verified` + 隔离恢复演练通过），容器已删除。生产需在 `/app/settings/backups` 重新配置目标。

### 7.4 密钥轮换手册

```bash
# 1) 改 SECRETBOX_KEY（新值写入 SECRETBOX_KEY，旧值临时写到 SECRETBOX_KEYS_LEGACY）
sudo vim /etc/licensing-saas/production.env
sudo npx tsx scripts/rotate-secrets.mts            # dry-run，先看扫描/待重封存数量
sudo npx tsx scripts/rotate-secrets.mts --apply    # 真正重封存
# 2) 确认输出“已是最新=N 失败=0”后，删除 SECRETBOX_KEYS_LEGACY
sudo systemctl restart licensing-saas
```

```bash
# 2) 轮换授权码 pepper：新值进 LICENSE_HMAC_PEPPER，旧值进 LICENSE_HMAC_PEPPER_LEGACY
#    旧码在客户端下次校验时自动重哈希到新 pepper，无需停机、无需重发授权码。
#    全部迁移完成后可清空 LEGACY（不影响已重哈希的行）。
```

轮换后自检：`/health/ready` 200、用一条旧授权码 `POST /api/v1/licenses/validate` 应返回
`valid:true`，且 `select hash_key_version, count(*) from license_keys group by 1` 逐步收敛到新版本。

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
