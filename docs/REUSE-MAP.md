# 复用地图 · 哪一步通用、哪一步必须换

> 回答一个问题：**下次换个项目/换台机器，这套流程能直接搬多少？**
> 用法：从上到下扫一遍，凡标「🔁 替换」的填好值就能用；标「✅ 通用」的原样照跑。

---

## 0. 一句话结论

整套流程里 **约 70% 是通用的**——恢复对账、重装依赖、systemd 常驻、五步验证、证书安装、多协议备份接入、远端独立取证，这些方法论和命令骨架换任何 Next.js + Prisma + PostgreSQL 项目都成立。

**必须换的 30%** 集中在四类：**路径与端口**、**账号与凭据**、**业务端点名**、**期望数值**。这四类恰好也是最容易照着抄错、抄错了还看不出来的地方。

---

## 1. 逐阶段对照表

### Phase 0 · 先读后做

| 项 | 类型 | 说明 |
| --- | --- | --- |
| `git log --oneline -5` / `git tag -l -n1` | ✅ 通用 | 摸版本基线 |
| `python3 -c "import json;d=json.load(open('package.json'));..."` 打印 scripts | ✅ 通用 | 比 `cat package.json` 省 token |
| `ls docs/` 并先读 handoff/runbook | ✅ 通用 | **这一步最省时间**，别跳过 |
| `ss -ltnp \| grep -E ':(80\|443\|3000\|3100)\b'` | ✅ 通用 | 先看谁占端口 |
| 查真实健康端点 | ✅ 通用（方法） | `find src/app -path '*health*' -o -path '*status*'`，或读 `Dockerfile` 的 `HEALTHCHECK` |
| 查 `GET /` 是否设计为跳转 | ✅ 通用（方法） | 读 `src/app/page.tsx` 首行 |
| 查 `next.config.ts` 是否开 `cacheComponents` | ✅ 通用（方法） | 决定能不能写 `export const dynamic` |
| 项目路径 | 🔁 替换 | 本项目 `/root/授权saas`（**含中文，命令要加引号**） |

---

### Phase 1 · 恢复数据 + 行数对账

| 项 | 类型 | 说明 |
| --- | --- | --- |
| `pg_restore --clean --if-exists --no-owner` | ✅ 通用 | 参数组合对所有 PG custom-format dump 都适用 |
| 逐表计数循环的 shell 骨架 | ✅ 通用 | 复制即用 |
| 差分定位（`comm -23` 找缺失主键，再看 `created_at`） | ✅ 通用 | 判断"少几行"是损坏还是 RPO |
| `PG_CONTAINER` | 🔁 替换 | `licensing-pg` |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 🔁 替换 | `licensing` / `licensing_dev_pw` / `licensing` |
| `HOST_PORT` | 🔁 替换 | `55432`（注意不是 5432） |
| `DUMP_PATH` | 🔁 替换 | `/tmp/licensing.dump`（**用户说跑完他自己清，别删**） |
| 表名清单 + 期望行数 | 🔁 替换 | `organizations=1 / customers=14 / products=4 / license_keys=232 / activations=444 / audit_logs=46 / api_request_logs=260` |

---

### Phase 2–3 · 重装依赖与构建

| 项 | 类型 | 说明 |
| --- | --- | --- |
| `rm -rf node_modules .next` | ✅ 通用 | 跨 Node 大版本必做 |
| `npm ci`（优先）/ `npm install`（回退） | ✅ 通用 | 有 `package-lock.json` 就 ci |
| Prisma engines 下载超时 → 重试 1 次 | ✅ 通用 | 别用 skip flags 绕过 |
| `npx prisma generate` → `npx tsc --noEmit` → `npm run build` | ✅ 通用（顺序） | 先 typecheck 再 build，噪音更少 |
| 包管理器 | 🔁 可能替换 | 若项目用 pnpm/yarn，命令需换 |
| generate 命令 | 🔁 可能替换 | Prisma 7 用 `prisma generate`；其他 ORM 不同 |

---

### Phase 4 · systemd 常驻

| 项 | 类型 | 说明 |
| --- | --- | --- |
| unit 模板整体结构（`After` / `Restart` / `KillSignal` / `TimeoutStopSec`） | ✅ 通用 | 复制即用 |
| **`ExecStart` 里的 `-H 127.0.0.1`** | ✅ 通用（**必须检查**） | Next 默认绑 `0.0.0.0`，不写就暴露公网 |
| `EnvironmentFile=` 而不是把密钥写进 `Environment=` | ✅ 通用 | unit 的 Environment 能被 `systemctl show` 看到 |
| `Environment=PATH=...` 显式写 | ✅ 通用 | systemd 的 PATH 比 shell 短，`npm` 可能找不到 |
| `Environment=NODE_ENV=production` | ✅ 通用 | |
| `SERVICE_NAME` | 🔁 替换 | `licensing-saas` |
| `PORT` | 🔁 替换 | `3100`（**不能占 3000**） |
| `PROJECT_DIR` | 🔁 替换 | `/root/授权saas` |
| `ENV_FILE` | 🔁 替换 | `/etc/licensing-saas/production.env` |
| 沙箱/第二实例 | 🔁 按需 | `3101` + `sandbox.env` + 独立库，本项目有，别的项目未必 |

---

### Phase 5 · 真验证（交付的全部价值）

| 项 | 类型 | 说明 |
| --- | --- | --- |
| 五步套路：状态码 → 健康端点 → 登录 cookie → 带会话打业务接口 → journal 错误数 0 | ✅ 通用（**骨架**） | 这五步能筛掉 95% 的"假跑通" |
| `journalctl -u X --since -5min \| grep -icE "error\|exception"` 期望 0 | ✅ 通用 | 最便宜的整体健康指标 |
| `curl -w "%{http_code}"` 写法 | ✅ 通用 | |
| 登录端点路径 | 🔁 替换 | `/api/v1/auth/login` |
| `origin` 头要求 | 🔁 按项目 | 本项目必须带 `origin: http://127.0.0.1:3100` |
| cookie 名 | 🔁 替换 | `lic_session` / `lic_csrf` |
| CSRF 头名 | 🔁 替换 | `x-csrf-token` |
| 业务资源路径 | 🔁 替换 | `/api/v1/admin/licenses?limit=1` 等 |
| 账号密码 | 🔁 替换 | `owner@xinglan.dev` / `License#2026` |
| 期望状态码 | 🔁 逐个确认 | `GET /` 本项目是 307 不是 200（`redirect()` 设计） |

---

### Phase 6 · HTTPS

| 项 | 类型 | 说明 |
| --- | --- | --- |
| 证书与私钥指纹比对的两条 `openssl` 命令 | ✅ 通用 | **落盘前必做**，不做就是赌 |
| `acme.sh --issue --webroot` + `--install-cert --reloadcmd` | ✅ 通用 | |
| ACME location 必须 `^~` 且写在 301 之前 | ✅ 通用 | 否则续期被自己的重定向吃掉 |
| 验证清单（`Verify return code: 0` / 301 / 200 / ACME 404 / `/metrics` 403 / 同机其他站点不变） | ✅ 通用 | |
| `DOMAIN` | 🔁 替换 | `<你的域名>` |
| `CERT_DIR` | 🔁 替换 | `/root/<你的域名>_ecc` |
| `SSL_DIR` | 🔁 替换 | `/opt/1panel/apps/openresty/openresty/conf/ssl/<你的域名>` |
| `NGINX_CONTAINER` | 🔁 替换 | `1Panel-openresty-91lk`（**`--network host`**） |
| 反代配置文件位置 | 🔁 替换 | `/opt/1panel/www/conf.d/<domain>.conf` |
| webroot | 🔁 替换 | `/opt/1panel/www/acme` → 容器内 `/www/acme` |
| 部署脚本 | 🔁 路径替换即可复用 | `/usr/local/bin/licensing-cert-deploy.sh`，逻辑通用 |

---

### Phase 7 · 多协议异地备份

| 项 | 类型 | 说明 |
| --- | --- | --- |
| 三协议容器起法（S3 versitygw / SFTP atmoz / WebDAV bytemark） | ✅ 通用 | 镜像名与参数可原样用 |
| 三协议各自的坑（bucket 预建、SSH 挂载路径、`SSH_AUTHORIZED_KEYS` 不支持、卷属主） | ✅ 通用 | 换机器照踩，提前规避 |
| 接入顺序：建目标 → 连接测试 → 加策略 → 触发 → 全 verified → sha256 全等 → verify → restore-test | ✅ 通用 | |
| **远端独立取证流程**（下载 → sha256 + 魔数 → 解密 → pg_restore → 表数对账 → 行数对账 → 关键列 diff → drop） | ✅ 通用 | **这是验收备份的唯一硬标准** |
| `POST /api/v1/admin/backups/jobs` 而不是 `/policies/{id}/run` | 🔁 按项目 | 本项目路由命名，换项目要查 |
| `policyId` | 🔁 替换 | `969407cb-afe4-4087-89b3-a4d6d093ebaf` |
| 目标 id（5 个） | 🔁 替换 | `7caee0f8…` / `15e48268…` / `e9cf8b34…` / `07f01316…` / `a662ac09…` |
| 远端端点与凭据 | 🔁 替换 | `http://[OFFSITE_HOST]:5244/dav` / `[BK_USER]` / `[BK_PASS]` / rootPath `/film` |
| 加密信封格式 | 🔁 按项目 | 本项目 `ZMBK1 \| iv(12) \| tag(16) \| ciphertext`，key = `sha256(env值)` |
| 解密脚本 | 🔁 按项目改 | `/tmp/offsite_decrypt.mjs`，抄 `src/lib/services/backup/crypto.ts` 的派生逻辑 |

---

## 2. 四类必须换的东西（换个项目最先出错的四个地方）

### 2.1 路径与端口

```
项目目录      /root/授权saas          ← 含中文，命令一律加引号
生产端口      3100                    ← 不能占 3000
沙箱端口      3101
PG 宿主端口   55432                   ← 不是 5432
保留端口      80 / 443 / 13331        ← openresty / dsh-web，不可碰
```

**换项目时要先跑**：`ss -ltnp`，别假设端口空着。

### 2.2 账号与凭据

```
后台登录      owner@xinglan.dev / License#2026
PG            licensing / licensing_dev_pw
外部 WebDAV   [BK_USER] / [BK_PASS]
```

**换项目时**：这些不在代码里，在用户脑子里或密码管理器里，**必须问**，不能猜。

### 2.3 业务端点名（最容易被"想当然"坑死）

| 你以为的 | 实际的 |
| --- | --- |
| `/api/health` | **不存在**。用 `/api/v1/status` / `/health/live` / `/health/ready` |
| `GET /` → 200 | **307** → `/app/dashboard`（`page.tsx` 首行 `redirect()`） |
| `/backups/policies/{id}/run` | **404 HTML**。用 `POST /backups/jobs` |
| `verify` 返 `expectedSha256` | 返 **`expected` / `actual`** |
| `restore-test` 有 `status` 字段 | **没有**，只有 `ok` / `checks` / `rtoSeconds` / `elapsedMs` |
| 备份触发响应有 `id` | 是 **`jobId`** |

**换项目时的做法**：`find src/app/api -name route.ts | sort` 列全量，别靠 REST 直觉猜。

### 2.4 期望数值

```
行数    organizations=1 customers=14 products=4 license_keys=232
        activations=444 audit_logs=46 api_request_logs=260
表数    41
授权数  240（业务行）
```

**换项目时**：这些数只有交接方能给。**写死到脚本里**，跑完逐个比对，不许"看起来差不多"。

---

## 3. 可以整段搬走的资产

| 资产 | 位置 | 搬走方式 |
| --- | --- | --- |
| 方法论 Skill | `~/.agents/skills/saas-migration-ops-delivery/`（待采纳） | 采纳后自动加载 |
| 完整 Prompt | `docs/PROMPT-v15.md`，`=== PROMPT BEGIN/END ===` 之间 | 复制粘贴，按替换索引填 |
| 交接文档模板 | `docs/HANDOFF-v15.md` | 换 §2 环境坐标、§4 完成项、§6 待完成即可 |
| 坑清单 | `docs/PITFALLS.md` | 全部通用，直接带走 |
| systemd unit 模板 | `docs/HANDOFF-v15.md` §2.2 | 改 4 个值 |
| 证书部署脚本 | `/usr/local/bin/licensing-cert-deploy.sh` | 改 `SRC`/`DST` 两个变量 |
| 三协议容器命令 | `docs/PITFALLS.md` + Skill Phase 7 | 镜像名与参数原样用 |
| 远端取证流程 | Skill Phase 7.3 + `docs/PITFALLS.md` C5 | 只需改解密脚本（按项目加密格式） |
| 验证脚本骨架 | `docs/HANDOFF-v15.md` §5 | 改端口/端点/cookie 名 |

---

## 4. 换新项目时的最短路径（清单式）

```
□ 1. 拿到：项目路径、端口、PG 容器名/账号/库名/dump 路径、期望行数、登录账号
□ 2. ss -ltnp 看端口；ls docs/ 找现有 handoff
□ 3. find src/app -path '*health*' -o -path '*status*'  → 确认健康端点真名
□ 4. 读 src/app/page.tsx 首行 → 确认 / 是否设计为跳转
□ 5. 读 next.config.ts → 确认 cacheComponents
□ 6. pg_restore（stdin 或 docker cp，别用容器读宿主路径）
□ 7. 逐表计数，与期望值精确比对
□ 8. rm -rf node_modules .next && npm ci
□ 9. prisma generate → tsc --noEmit → build
□ 10. 写 systemd unit（-H 127.0.0.1 + EnvironmentFile）→ enable --now
□ 11. ss -ltnp 确认只绑 127.0.0.1
□ 12. 五步验证（状态码 / 健康 / 登录 cookie / 业务接口 / journal 0 错）
□ 13. HTTPS：指纹比对 → nginx -t → reload → s_client 验链 → 301/200/403 三点
□ 14. 备份：接目标（连接测试要真上传+下载+删除）→ 加策略 → 触发 → 全 verified
□ 15. 从远端下载那份文件 → 解密 → pg_restore → 逐表对账 → drop 临时库
□ 16. 写 HANDOFF（环境坐标 / 不变式 / 已完成证据 / 待完成 / 禁区）
□ 17. tsc + build + 单测 + journal 全绿 → 提交 → git tag -f -a
□ 18. 汇报：每个数字都来自本次真实输出，未验证的写"未确认"
```

---

## 5. 判断「能不能算完」的三条硬标准

1. **每个验收项都有本次跑出来的原始输出**（状态码、行数、sha256、错误计数），不是"应该没问题"。
2. **备份能用**指的是：从**远端**取回字节 → 解密 → 灌库 → 对账通过。哈希相等不算。
3. **报告里的"异地"** 指的是独立主机。同机容器再多也只能叫"多副本"。
