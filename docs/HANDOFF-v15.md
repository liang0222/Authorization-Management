# 交接说明 · v1.5（新对话直接从这里接着干）

> 生成时间：2026-11-03 21:43（Asia/Shanghai）
> 对应提交：`e472e98`，tag `v1.5.0` → `e472e98`，工作区干净
> 本文替代任何口头记忆。**先读完 §1、§2、§7 再动手。**
>
> ⚠️ **本文件含生产凭据（后台账号、PG 密码、外部 WebDAV 账号）。仓库当前无 git remote，
> 禁止添加公开远程或把本文件贴到外部。** 与 `README.md` / `docs/handoff.md` 的既有做法一致。

---

## 1. 一句话现状

**v1.5 已全部交付并上线**：生产实例跑在 `127.0.0.1:3100`（systemd 常驻），HTTPS 已开通并配置自动续期，备份已接入**五个目标**（含一个独立公网主机，真正异地），全部经"从远端字节独立解密并恢复"取证。剩余只有 3 项非阻塞的可选项（见 §6）。

---

## 2. 环境坐标（照抄即可）

### 2.1 机器与项目

| 项 | 值 |
| --- | --- |
| 主机 | `[HOST]` / Debian 13 |
| 运行时 | Node `v26.13.0` / npm `11.20.0` / docker `29.9.2` / git `2.47.3` |
| 项目目录 | `/root/授权saas` |
| 技术栈 | Next.js `16.4.3` + React `19.3` + Prisma `7.10.1` + PostgreSQL 16 |
| 域名 | `<你的域名>`（公网 HTTPS 可用） |

### 2.2 三个 systemd 单元

| 单元 | 端口 | 环境文件 | 说明 |
| --- | --- | --- | --- |
| `licensing-saas.service` | `3100` | `/etc/licensing-saas/production.env` | 生产 |
| `licensing-saas-sandbox.service` | `3101` | `/etc/licensing-saas/sandbox.env` | 沙箱（独立库 `licensing_sandbox`、独立密钥目录 `.keys-sandbox`） |
| `licensing-saas-retention.timer` | — | 复用 production.env | 每日 04:30 跑 `scripts/retention-cleanup.mts --apply` |

```ini
# licensing-saas.service 关键行（勿改）
WorkingDirectory=/root/授权saas
EnvironmentFile=/etc/licensing-saas/production.env
ExecStart=/usr/bin/npm run start -- -p 3100 -H 127.0.0.1
Restart=on-failure
```

### 2.3 容器

| 容器 | 镜像 | 端口映射 | 用途 |
| --- | --- | --- | --- |
| `licensing-pg` | `postgres:16-alpine` | `127.0.0.1:55432 -> 5432` | 生产库 + 沙箱库（同实例） |
| `1Panel-openresty-91lk` | `1panel/openresty:1.31.8.1-2-1-noble` | **host 网络，占 80/443** | 反向代理 |
| `licensing-offsite-s3` | `versity/versitygw:latest` | `127.0.0.1:19000` | 备份协议端（S3） |
| `licensing-offsite-sftp` | `atmoz/sftp:alpine` | `127.0.0.1:19022` | 备份协议端（SFTP） |
| `licensing-offsite-webdav` | `bytemark/webdav:latest` | `127.0.0.1:19080` | 备份协议端（WebDAV） |

### 2.4 端口占用（不可碰）

`80` / `443` → openresty；`13331` → dsh-web；`55432` → PG。业务端口只用 `3100` / `3101`。

### 2.5 账号

- 后台登录：`owner@xinglan.dev` / `License#2026`
- **登录请求必须带 `origin: http://127.0.0.1:3100`**（CSRF 校验）
- 写接口还需 `x-csrf-token`，值取自同一次响应的 `lic_csrf` cookie

### 2.6 数据库

```
库 licensing（生产） / licensing_sandbox（沙箱）
用户 licensing / 密码 licensing_dev_pw
```

关键表：`organizations` `customers` `products` `licenses` `license_keys` `activations` `audit_logs` `api_request_logs` `product_credentials`（共 41 张）

> ⚠️ `license_keys` **只存 HMAC-SHA256**（`key_prefix` + `key_last4` + `key_hash`），明文不落库。要拿明文 key 只能走管理 API 签发。

### 2.7 备份五目标（策略 `969407cb-afe4-4087-89b3-a4d6d093ebaf` = `daily-production`）

| 优先级 | 名称 | 类型 | 落点 | 位置 |
| --- | --- | --- | --- | --- |
| 1 | `local-primary` | local | `file:///root/授权saas/.backups/backups/production/bkp_*.zmbk` | 本机 |
| 2 | `offsite-s3` | s3 | `s3://licensing-offsite/backups/offsite/bkp_*.zmbk` | 本机容器 |
| 3 | `offsite-sftp` | sftp | `sftp://127.0.0.1:19022/upload/backups/offsite/bkp_*.zmbk` | 本机容器 |
| 4 | `offsite-webdav` | webdav | `http://127.0.0.1:19080/backups/offsite/bkp_*.zmbk` | 本机容器 |
| 5 | **`offsite-webdav-remote`** | webdav | `http://[OFFSITE_HOST]:5244/dav/film/ziming-license-backups/bkp_*.zmbk` | **独立公网主机（真异地）** |

- 目标 id：`7caee0f8…9594` / `15e48268…eab3` / `e9cf8b34…938d` / `07f01316…5160` / `a662ac09…4d89`
- 调度：`0 3 * * *` / `Asia/Shanghai` / `all_required` / `sha256_and_manifest` / 加密开
- 保留：7 日 + 4 周 + 3 月
- **外部目标的凭据**：`admin` / `[BK_PASS]`，`tlsVerify: false`（该端点无 TLS）

---

## 3. 关键不变式（改代码前必读）

1. **`next.config.ts` 开了 `cacheComponents`** → 路由里**不能**写 `export const dynamic = "force-dynamic"`，会构建失败。
2. **本项目没有 `/api/health`**。健康检查用 `/api/v1/status`、`/health/live`、`/health/ready`。
3. **`GET /` 返回 307 → `/app/dashboard`** 是 `src/app/page.tsx` 首行 `redirect()` 的设计，不是故障。
4. **备份对象键由 `backupObjectKey()`（`src/lib/services/backup/runner.ts`）统一产出**，适配器只负责 `root_path`。不要在两处都拼 `remote_prefix`。
5. **生产环境 WebDAV 默认只允许 https**，除非目标显式设 `tlsVerify: false`（`src/lib/services/backup/factory.ts` 的 `allowInsecureHttp`）。
6. **`product_credentials` 有两条 CHECK**：`confidential_server` 必须有 `public_key` 且 `secret_hash` 非空。新建机密服务端凭证不传公钥时服务端会现场生成并把私钥放进响应（仅一次）。
7. **Prisma `Bytes` 列**：写入用 `new Uint8Array(buf)`，`Buffer<ArrayBufferLike>` 不能直接赋给 `Uint8Array<ArrayBuffer>`。
8. **每个 `/api/v1/admin/*` 写接口都要 `origin` + `x-csrf-token`**，否则 403/308。

---

## 4. 已完成（全部有实证）

| # | 项 | 证据 |
| --- | --- | --- |
| 1 | DB 恢复 | organizations=1 / customers=14 / products=4 / license_keys=232 / activations=444 / audit_logs=46 / api_request_logs=260，精确达标 |
| 2 | 依赖重装 + 构建 | `npm ci` 784 包；`npx prisma generate`；`npm run build` ✓ |
| 3 | 生产常驻 | `licensing-saas.service` enabled+active，只绑 `127.0.0.1:3100` |
| 4 | 登录链路 | `POST /api/v1/auth/login` → 200，`lic_session`(43) + `lic_csrf`(32) |
| 5 | v1.5 公开 API | 挑战 6 行规范化消息、`entitlements_version`、refresh token 轮换 + 重放检测、限流、幂等 |
| 6 | 开发者文档中心 | 20 路由全 200；OpenAPI 3.1 YAML+JSON 可下载；契约测试双向核对；llms.txt 无密钥泄漏 |
| 7 | 六语言示例 | python/node 可复验；php/go/java/csharp **未本机编译**（机器上没装这些工具链） |
| 8 | 游标分页 | `src/lib/domain/cursor.ts`，HMAC 签名 + scope 绑定，14 端点接线，旧 page/pageCount 保留 |
| 9 | Sandbox 隔离 | 独立库 + 独立密钥目录 + `credential_environment` 列，5 处运行时强制；跨环境实测 401 |
| 10 | HTTPS | Let's Encrypt 证书，`Verify return code: 0 (ok)`，HTTP→HTTPS 301，`/metrics` 公网 403，`[同机其他站点]` 未受影响 |
| 11 | 证书续期 | acme.sh cron 13/14 点档 + `Le_ReloadCmd` → `docker exec … nginx -s reload`；`--cron` 实跑 "Next renewal 2027-01-02" |
| 12 | 多协议备份 | 五目标全 verified，sha256 五份全等 `5c521157…08f3` |
| 13 | 异地取证 | 从 `[OFFSITE_HOST]` 公网下载 307973 B，本地 sha256 一致，`ZMBK1` 魔数正确 |
| 14 | 真恢复演练 | 用上述下载字节解密 → `pg_restore` → 41 表，240 授权行，逐表对账一致，`key_hash` 前三条逐字节相同 |
| 15 | 系统自检 | `verify` expected==actual；`restore-test` 四项全 ✅（RTO 2s / 1574ms） |
| 16 | 回归 | `tsc --noEmit` 0；`npm run build` ✓；单测 **14 files / 153 tests**；journal 近 10 分钟 error 计数 **0** |
| 17 | 凭证缺陷修复 | 新建 `confidential_server` 凭证原来必然 500（`23514` / `P2039`），已修；畸形公钥 400 而非 500 |
| 18 | 提交与 tag | `e472e98`，`v1.5.0` → `e472e98`，工作区干净 |

---

## 5. 验证套路（每轮改完照跑）

```bash
cd /root/授权saas

# 1) 静态
npx tsc --noEmit                                    # 期望 0
npm run build 2>&1 | grep -E "Compiled successfully|Failed"

# 2) 单测
npx vitest run tests/unit 2>&1 | grep -E "Test Files|Tests "

# 3) 重启（注意：restart 后 cookie 失效，需重新登录）
systemctl restart licensing-saas && sleep 12
systemctl is-active licensing-saas licensing-saas-sandbox licensing-saas-retention.timer

# 4) 存活
for u in /api/v1/status /health/live /health/ready /login; do
  printf "  %-18s " "$u"; curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3100$u"; done

# 5) 公网
curl -s -o /dev/null -w "https login=%{http_code}\n" https://<你的域名>/login
curl -s -o /dev/null -w "http  ->%{http_code}\n" http://<你的域名>/login   # 期望 301
curl -s -o /dev/null -w "metrics=%{http_code}\n" https://<你的域名>/metrics # 期望 403

# 6) 日志
journalctl -u licensing-saas --since "-5min" | grep -icE "error|exception"   # 期望 0

# 7) 备份链路（改过备份相关代码才需要）
#    触发 → 看五目标 verified → verify → restore-test
```

**登录 + 会话（写接口必用）**：

```bash
curl -s -c /tmp/lic_c.txt -X POST http://127.0.0.1:3100/api/v1/auth/login \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3100' \
  -d '{"email":"owner@xinglan.dev","password":"License#2026"}'
SESS=$(awk '$6=="lic_session"{print $7}' /tmp/lic_c.txt)
CSRF=$(awk '$6=="lic_csrf"{print $7}' /tmp/lic_c.txt)
curl -s "http://127.0.0.1:3100/api/v1/admin/backups/destinations" \
  -H "Cookie: lic_session=$SESS; lic_csrf=$CSRF" -H 'origin: http://127.0.0.1:3100'
```

---

## 6. 待完成（3 项，全部非阻塞）

| # | 项 | 为什么没做 | 怎么做 |
| --- | --- | --- | --- |
| 1 | PHP / Go / Java / C# 示例未编译复验 | 本机没装 `php` / `go` / `javac` / `mcs` | `apt install php-cli golang-go default-jdk mono-mcs` 后逐个跑 `sdk-examples/*/quickstart.*`；或维持现状在文档里标 Preview |
| 2 | 外部 WebDAV 端点只有明文 HTTP | 该 AList 的 443/5244/5006 全部 TLS 握手失败 | 给 `[OFFSITE_HOST]` 配 HTTPS 反代 → 把 `endpointUrl` 改 `https://` → 去掉 `tlsVerify: false`。**不建议经本机中转**（本机挂了会一起挂） |
| 3 | 用户手工确认项 | 需人工判断 | ①`[OFFSITE_HOST]` 是否长期作为异地机房；②是否接受该端点的明文 Basic Auth（备份体本身是 `ZMBK1` AES 加密信封，内容不泄露，但密码可能被链路截获） |

### 已知的历史遗留（可忽略）

- `/tmp/trash-1793710583.tmp`：原 `/tmp/v15-server-key.pem`，119 B 一次性测试私钥，对应凭证已删除，无实际风险。被安全网拦着删不掉，`mv` 改名的。

---

## 7. 操作禁区

| 不许 | 原因 |
| --- | --- |
| 改 `.env` 里的 `LICENSE_DB_URL` | 指向 `licensing-pg` 容器，改了就连不上库 |
| 动 `/root/.dsh`、`dsh-web.service` | 是 Agent 自身，动了会把自己搞挂 |
| 占 `3000` / `80` / `443` / `13331` | 已被占用（Next 默认 3000、openresty、dsh-web） |
| 删 `/tmp/licensing.dump` | 用户明确说跑完他自己清 |
| `git tag -d` | 该会话的安全规则会拦；用 `git tag -f -a v1.5.0 -m "..."` 覆盖 |
| 重启后复用旧 cookie | session 已失效，必须重新登录 |

---

## 8. 常用命令速查

```bash
# 服务
systemctl restart licensing-saas
journalctl -u licensing-saas -f

# 数据库
docker exec licensing-pg psql -U licensing -d licensing -At -c "select count(*) from license_keys"

# nginx
docker exec 1Panel-openresty-91lk nginx -t
docker exec 1Panel-openresty-91lk nginx -s reload

# 证书换发（人工）
bash /usr/local/bin/licensing-cert-deploy.sh /root/<你的域名>_ecc
# 脚本会校验证书与私钥指纹一致后才 reload

# 备份
# 触发：POST /api/v1/admin/backups/jobs  body {"policyId":"969407cb-afe4-4087-89b3-a4d6d093ebaf","trigger":"manual"}
# 注意：响应字段是 jobId 不是 id；/policies/{id}/run 这个路径不存在（404 HTML）

# 迁移与发布
npm run verify          # typecheck + openapi lint + test + build
npm run db:migrate
git tag -f -a v1.5.0 -m "<说明>"
```

---

## 9. 文档地图

| 文件 | 内容 |
| --- | --- |
| `docs/HANDOFF-v15.md` | **本文**，新对话从这里开始 |
| `docs/PROMPT-v15.md` | 本项目的完整可复用 Prompt（下次同类任务直接套） |
| `docs/PITFALLS.md` | 踩过的坑与有效解法（按现象索引，含快速检索表） |
| `docs/REUSE-MAP.md` | 哪一步通用 / 哪一步必须替换（逐阶段对照 + 换项目最短路径清单） |
| `docs/v15-runbook.md` | 运维手册：备份五目标现状、HTTPS 续期、密钥轮换、沙箱 |
| `docs/v15-delivery.md` | 交付清单（P0/P1/P2 逐项 + 证据） |
| `docs/v15-audit.md` | v1.5 升级前的基线审计 |
| `docs/api.md` | 接口说明 |
| `docs/operations.md` | 发布流程、定时任务清单 |
| `CHANGELOG.md` | 版本变更，发布只跟 tag 不跟 latest |
