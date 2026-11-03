# 本项目的完整可复用 Prompt（v1.5 定稿版）

> 把下面整段 `=== PROMPT BEGIN ===` 到 `=== PROMPT END ===` 之间的内容直接粘给新对话即可。
> 方括号 `[ ]` 里是**每次要替换**的部分；其余可原样复用。
> 本文以「最后确认的要求」为准：以生产运行为交付标准、以真实取证为验收标准、以诚实报告为汇报标准。

---

=== PROMPT BEGIN ===

## 背景

这台机器是 `[HOST_IP]`（Debian 13，Node `[NODE_VER]`，npm `[NPM_VER]`，docker 已装）。
项目在 `[PROJECT_DIR]`（`[STACK]`，例如 Next.js 16.4.3 + React 19.3 + Prisma 7.10.1 + PostgreSQL 16），
已经从另一台机器整目录同步过来，包含 `.env`、`prisma/`、`package.json`、`package-lock.json`、
`node_modules`（`[OLD_NODE_VER]` 环境装出来的，需要重装）、旧的 `.next`（需要重建）。

已完成的部分（**不要重复做**）：
- PostgreSQL `[PG_VER]` 容器 `[PG_CONTAINER]` 已经跑起来：`127.0.0.1:[PG_HOST_PORT] -> 5432`，
  用户 `[DB_USER]` / 密码 `[DB_PASSWORD]` / 库 `[DB_NAME]`，数据卷 `[PG_VOLUME]`。
- 数据库 dump 文件在 `[DUMP_PATH]`（custom format）。

## 任务：把项目在这台机器上跑通，按顺序做，每步都要验证再往下

### 1）恢复数据

```bash
docker exec -i [PG_CONTAINER] pg_restore -U [DB_USER] -d [DB_NAME] --clean --if-exists --no-owner < [DUMP_PATH]
```

完成后逐表验证行数，必须是：`[TABLE1]=[N1], [TABLE2]=[N2], ...`（把期望值写死，精确到个位）。
用 `docker exec [PG_CONTAINER] psql -U [DB_USER] -d [DB_NAME] -At -c "select count(*) from [TABLE1]"` 这类命令核对。

### 2）重装依赖

```bash
cd [PROJECT_DIR]
npm ci          # 有 package-lock.json 优先 ci；失败再退 npm install
```

注意：Prisma 的 engines 需要在 install 时下载，可能因网络慢超时，失败就重试一次。

### 3）重建 Prisma Client 和构建

```bash
npx prisma generate
npm run build   # 如果报 engine 不支持，记录原始报错
```

### 4）起服务

用 systemd 建一个 `[SERVICE_NAME]`：

```
WorkingDirectory=[PROJECT_DIR]
Environment=NODE_ENV=production
EnvironmentFile=[ENV_FILE]
ExecStart=/usr/bin/npm run start -- -p [PORT] -H 127.0.0.1
Restart=on-failure
RestartSec=3
```

enable 并 start，**监听 `127.0.0.1:[PORT]`**（不要占用 `[RESERVED_PORTS]`，不要碰 `[OTHERS_SERVICES]`）。

### 5）验证（必须真跑，不许只看进程在不在）

- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:[PORT]/` — 期望 200
- 确认返回 HTML 不是报错页（**健康端点要先从代码里查清楚真实路径，不要猜**）
- 用 curl 走一次登录接口，账号 `[EMAIL]` / 密码 `[PASSWORD]`，确认能拿到会话 cookie
- 从数据库抽一条真实业务数据调用一次业务接口，确认返回结构正常
- `journalctl -u [SERVICE_NAME] --since "-5min" | grep -iE "error|exception"` 必须为空

## 约束

- 不要改 `.env` 里的 `[DB_URL_KEY]`（指向的正是上面这个容器）。
- 不要动 `[FORBIDDEN_PATHS_OR_SERVICES]`。
- 不要删 `[DUMP_PATH]`，跑完我来清。
- 每一步失败先给原始报错和你的判断，不要静默重试超过 2 次，也不要跳过验证直接说"应该没问题"。
- **工具被拦或没拿到输出时只能说"未确认"，绝不能按预期补全。**

## 汇报结构

`当前阶段 / 已完成 / 验证结果（贴 curl 状态码和行数）/ 遇到的问题（原始报错）/ 下一步 / 需要我操作吗`

---

## 追加阶段（v1.5 过程中确认要做的，按需追加）

### 6）HTTPS

域名 `[DOMAIN]`，证书在 `[CERT_DIR]`（或需要我用 acme.sh 签发）。
要求：80 只留 ACME 校验路径 + 301，443 走 TLSv1.2/1.3 + HSTS，证书与私钥**指纹必须核对一致**后才 reload，
`/metrics` 在反代层 `deny all`，同机其他站点不能受影响，续期要自动化。

### 7）异地备份

把 `[PROVIDER]`（地址 `[ENDPOINT]`，账号 `[BK_USER]`，密码 `[BK_PASS]`，路径 `[BK_PATH]`）
接成备份策略的异地目标。要求：
- 连接测试必须**真上传 + 下载比对 + 删除**，不是只看 PROPFIND
- 加进策略后跑一次全量备份，所有目标 `verified` 且 sha256 全等
- **不信任作业记录**：从远端独立下载那份文件，本地算 sha256、校验魔数，再用这份字节解密并 `pg_restore`，
  逐表对账行数与关键列一致性
- 如实说明各目标是真异地还是同机容器，以及链路是否明文

## 通用验收纪律（每一轮都适用）

1. 先读后做：`git log` / `package.json` scripts / `docs/` / 端口占用，别重新推导已有结论。
2. 每步验证再往下，不静默重试，不跳过验证。
3. 报告里的每个数字、每个状态码都必须来自本次真实输出。
4. 无法验证的事情明确写"未确认"，并说明为什么。
5. 分清"能跑"和"跑对"：哈希相等 ≠ 能恢复；进程 active ≠ 服务可用。

=== PROMPT END ===

---

## 替换索引（下次照这张表改）

| 占位符 | 本次实际值（licensing-saas） | 说明 |
| --- | --- | --- |
| `[HOST_IP]` | `[HOST]` | 目标机 |
| `[NODE_VER]` / `[NPM_VER]` | `v26.13.0` / `11.20.0` | `node -v` / `npm -v` |
| `[PROJECT_DIR]` | `/root/授权saas` | 项目根 |
| `[STACK]` | Next.js 16.4.3 + React 19.3 + Prisma 7.10.1 + PG16 | 技术栈 |
| `[OLD_NODE_VER]` | `24` | 旧 node_modules 的 Node 版本 |
| `[PG_CONTAINER]` | `licensing-pg` | `docker ps` 查 |
| `[PG_HOST_PORT]` | `55432` | 宿主端口 |
| `[PG_VER]` | `16` | `postgres:16-alpine` |
| `[DB_USER]` / `[DB_PASSWORD]` / `[DB_NAME]` | `licensing` / `licensing_dev_pw` / `licensing` | |
| `[PG_VOLUME]` | `licensing-pgdata` | `docker inspect` 查 |
| `[DUMP_PATH]` | `/tmp/licensing.dump` | 284K custom format |
| `[TABLE*]` / `[N*]` | organizations=1 / customers=14 / products=4 / license_keys=232 / activations=444 / audit_logs=46 / api_request_logs=260 | 期望行数 |
| `[SERVICE_NAME]` | `licensing-saas` | systemd 单元名 |
| `[ENV_FILE]` | `/etc/licensing-saas/production.env` | 环境文件，`chmod 600` |
| `[PORT]` | `3100` | 生产端口 |
| `[RESERVED_PORTS]` | `3000 / 80 / 443 / 13331` | 不能占 |
| `[OTHERS_SERVICES]` | `openresty（80/443）、dsh-web（13331）` | 不能碰 |
| `[EMAIL]` / `[PASSWORD]` | `owner@xinglan.dev` / `License#2026` | 后台账号 |
| `[DB_URL_KEY]` | `LICENSE_DB_URL` | 不可改 |
| `[FORBIDDEN_PATHS_OR_SERVICES]` | `/root/.dsh`、`dsh-web.service` | 不可动 |
| `[DOMAIN]` | `<你的域名>` | 域名 |
| `[CERT_DIR]` | `/root/<你的域名>_ecc` | 证书目录 |
| `[PROVIDER]` / `[ENDPOINT]` / `[BK_USER]` / `[BK_PASS]` / `[BK_PATH]` | `webdav` / `http://[OFFSITE_HOST]:5244/dav` / `admin` / `[BK_PASS]` / `/film` | 异地备份 |

---

## 与旧版的差异（为什么这么改）

| 旧要求 | 最后确认的要求 | 原因 |
| --- | --- | --- |
| "起服务，看进程在不在" | `-H 127.0.0.1` 显式绑定 + `ss -ltnp` 确认 | Next 默认绑 `0.0.0.0`，会把服务暴露公网 |
| "curl /api/health 期望 200" | **先从代码查真实健康端点** | 本项目没有 `/api/health`，真实端点是 `/api/v1/status` |
| "`GET /` 期望 200" | 允许 307，只要能到 dashboard | `src/app/page.tsx` 首行 `redirect()` 是设计 |
| "备份 sha256 相等就算成功" | 从远端下载 → 解密 → `pg_restore` → 逐表对账 | 哈希相等只证明"字节没坏"，不证明"能恢复" |
| "异地备份接上就行" | 必须说明是真异地还是同机容器 | 同机容器的备份扛不住整盘损毁 |
| "有问题重试" | 最多重试 1–2 次，必须贴原始报错 | 静默重试会掩盖真因 |
| 口头汇报进度 | 落盘成 `docs/HANDOFF-v15.md` 等文件 | 对话会变长、会换模型，只有文件能传递 |
