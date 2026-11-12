# 变更记录

本文件记录每一次对外可见的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布规则（规格 23.1）：生产发布只使用不可变 Git Tag，不跟随 `latest`；每次发布在本文档记录
Release Note、commit、迁移 ID 与回滚方式。

---

## [Unreleased]

### 安全 · 备份明文通道需要双重确认（阶段 4）

**问题**：`factory.ts` 的判定是 `allowInsecureHttp = DEPLOYMENT_ENV !== "production" || row.tls_verify === false`。
`tls_verify` 的语义是「跳过证书校验」，却被当成了「同意明文」的授权书——生产环境只要把备份目标的
`tls_verify` 设成 `false`，非回环的 `http://` WebDAV 就会放行，Basic Auth 口令与备份内容全程明文过网。
生产库里 `offsite-webdav-remote`（`http://96.62.250.65:5244/dav`，`tls_verify=false`）正是这种状态。

**现在**：判定收到 `src/lib/services/backup/insecure-http.ts`（`evaluateInsecureHttpTarget`），
保存接口、执行器与页面 DTO 共用同一个函数：

- 生产 + `http://` + 非回环：必须同时满足「目标上显式 `tls_verify=false`」与「环境变量
  `ALLOW_INSECURE_BACKUP_HTTP=true`」，缺任一 → 创建/更新返回 **400 `INSECURE_HTTP_NOT_CONFIRMED`**
  （`details.requires` 列出缺哪两项），执行期则**跳过该目标**并把作业降级为 `degraded`
  （`error_code=BACKUP_TARGET_INSECURE_SKIPPED`），绝不静默明文发送。
- 回环（`localhost` / `127.0.0.0/8` / `::1` / `0.0.0.0`）与 `https` / `sftp` / `local` 不受限；非生产环境行为不变。
- 变量只认精确 `true`，默认不设置；代码里没有任何绕过分支。

**审计与可见性**：每次保存「不合规但被双重确认放行」的目标写一条
`audit_logs.action = backup.target_insecure_accepted`（`after_data` 含 `host`、`provider_type`、`tls_verify`、
`confirmed_by`，`actor_id` 为操作者）；`/api/v1/admin/backups/overview` 的 `destinations` 增加
`plaintext` / `plaintextAccepted` / `plaintextBlocked` 三个计数，目标 DTO 增加 `insecureHttp` 明细，
备份设置页对这类目标显示红色「明文传输」徽章。

**部署影响（需要人工确认一次）**：现网 5 个目标中只有 `offsite-webdav-remote` 属「非回环 + http」。
不带 `ALLOW_INSECURE_BACKUP_HTTP=true` 时，上线后它会从「每次都传」变成「每次跳过 + 作业 degraded」
（其余 4 个目标照常，本地备份不受影响）。两条路：①正解——把它改成 https 或内网隧道；
②过渡——在 `production.env` 加 `ALLOW_INSECURE_BACKUP_HTTP=true` 并接受审计留痕。
上线检查 SQL 见 `docs/v15-runbook.md` §4.1.1。

**回滚**：本阶段只改判定与展示，不动加密、格式、调度、保留策略，数据库无结构变更；
回滚代码即可，`ALLOW_INSECURE_BACKUP_HTTP` 留着也无副作用（只有代码读它）。

### 架构 · 拆分 Universal Installer：运行时解耦 + 代码与数据隔离（阶段 3）

安装器原本长在授权系统里，宿主不光打包它，还要**读它的锁文件**才敢起后台任务——部署形态被一个
可选组件的状态绑架。本阶段分两步把它剥出去，安装器的代码、页面、API、测试全部搬到
`packages/universal-installer/`，宿主侧的构建产物里不再有它们。

**第一步 · 运行时解耦**

- `src/lib/background.ts`：`backgroundWorkersAllowed()` 从「读 `<dataRoot>/licensing-saas/installed.lock`」
  改成查数据库就绪（`SELECT to_regclass('public.webhook_deliveries'), to_regclass('public.backup_policies')`），
  返回 `{ allowed, detail }`；缺表时 detail 写明缺哪张表、跑完迁移重启即可。连接串里的口令在 detail 里被 `scrub()` 抹掉。
- `src/instrumentation.ts`：未就绪时打 `[boot] 后台任务未启动：<原因>`，不再出现「尚未安装，跳过后台任务」。
- `src/proxy.ts` / `src/app/page.tsx`：`/` 恒重定向 `/app/dashboard`，不再按安装状态分流（原来会甩到 `/install`）。
- `/install` 页与 `/api/install/{state,probe,run,log}` 从宿主移出：路由表 132→127、页面 49→48、API 路由 74→70、
  静态页 106→101。

**第二步 · 代码与数据隔离**

- 新包 `packages/universal-installer/`：`app/install`、`app/api/install`、`components/install`、`lib/installer`、
  `tests/`（108 条）、`database/`、以及自带的 `README.md` / `package.json` / `tsconfig.json` / `vitest.config.ts`。
  包内已无宿主的 `@/lib/*` 别名 import（`grep '"@/' packages/universal-installer` 为空）。
- 唯一耦合层 `host/` 四个文件：`password.ts`、`permissions.ts`（逐字副本，注明来源与同步规则）、
  `database-url.ts`（抄 `DEV_DEFAULTS.LICENSE_DB_URL` 规则）、`prisma-client.ts`（唯一指向宿主生成物的一行相对 import）。
- `prisma/schema.prisma` 删除 `model installer_records`；**表与数据不动**。新增迁移
  `20261113000000_installer_records_handoff` 是**故意什么都不做**的空迁移（纯注释、0 条 SQL）——
  Prisma 按 schema 差异自动生成会带 `DROP TABLE "installer_records";`，那样已部署实例的安装记录就没了。
  表定义改由包内 `database/installer_records.sql` 持有（幂等 `CREATE TABLE IF NOT EXISTS`，与历史 DDL 一致）。
- 适配器 `recordInstall()` 从 `db.installer_records.upsert()` 改成原生 SQL `INSERT ... ON CONFLICT (project_id) DO UPDATE`
  （宿主 schema 已无该模型句柄）；安装器也不再反向 import 宿主的 `@/lib/background` 去替宿主启动定时器。

**验证**（隔离副本 + 专用临时库）

- 宿主：`tsc --noEmit` 0 错误；`npx vitest run` **227 passed (20 files)**、`npm run test:installer` **108 passed (6 files)**
  （335−108=227，移走的 6 个文件逐项对得上：config-writer 18 / database 17 / lock 12 / manifest 20 / state 13 / store 28）；
  `npm run build` exit 0、101/101 静态页、路由表 127 条且**无 install 行**。
- 全新临时库 `migrate deploy` + seed + `next start`：日志 `[boot] env=sandbox … 配置检查通过` /
  `[webhook] dispatcher started` / `[backup] scheduler started`，`「尚未安装」出现 0 次`。
- 集成测试 12 passed；登录→签发→激活→心跳→解绑手工复验 200/200/201/200/201/200/200，解绑后旧令牌 401。
- 数据保留实证：临时库先建表塞 3 行（内容 md5 `ac0ec532e254f795c880629ce01edc08`），走完新迁移后行数与 md5 **完全不变**，
  索引仍在；`grep -v '^\s*--' migration.sql` 输出为空，drop/truncate/delete 检索 0 命中。

**部署影响 / 回滚**

- 无需 DDL：空迁移不产生任何语句，已部署库的 `installer_records` 原样保留；全新库由历史迁移 `20261104120000_installer_records` 建表。
- 升级动作：`npm ci && npx prisma generate && npm run build && systemctl restart licensing-saas`；`/install` 会 404（不再挂载）。
- 回滚：两步各一个提交，可分别 `git revert`；数据无需回滚。细节见 `docs/handoff.md` §2.4。

- 记录更新：`README.md`（数量口径 48/70/78、§5 目录树加 `packages/`、§7 新增解耦条目）、
  `docs/handoff.md` §1/§2.1/§2.3 + 新增 §2.4、`packages/universal-installer/README.md`。

### 安全 · 生产防呆护栏：seed 拒跑、演示账号拦启动、上线前自检（阶段 2）

阶段 0 踩过的那次「`npm run db:seed` 打到生产库、3100 变 503」不该只靠人记性避免；现网库里还留着
seed 建的三个演示账号（密码是公开的 `License#2026`）。本阶段把这三件事做成代码常量。

- **seed 护栏（`src/lib/seed-guard.ts` + `prisma/seed.ts`）**：在**连库之前**判断身份，
  `NODE_ENV=production` 或 `DEPLOYMENT_ENV=production` 时默认拒绝执行并以退出码 1 结束，
  报错正文说明「本脚本会先 TRUNCATE 30 张业务表」；只有显式 `ALLOW_DEMO_SEED=true` 才放行，
  且放行前打印 ⚠️ 横幅。两个变量取「或」——误跑的两种姿势（容器只配 `DEPLOYMENT_ENV`、
  拿生产构建连生产库）都真实存在。判定只认精确的 `"true"`，`1`/`TRUE`/`yes`/`on` 不算豁免。
  演示数据内容本身未改动。
- **启动检测（`src/lib/demo-accounts.ts` + `src/instrumentation.ts`）**：`DEPLOYMENT_ENV=production`
  启动时查 `users` 表，命中 `*@xinglan.dev` 或种子 displayName（陈星岚 / 林可 / 周睿（审计））
  就**每个账号一条 issue** 并入阶段 1 的启动闸门（生产构建 → 退出码 1）。查库失败（全新实例还没建表）
  只降级为一行警告，不拦安装器；开发/沙箱根本不查。
- **上线前自检（`src/lib/prod-env-check.ts` + `scripts/check-prod-env.mts` + `npm run check:prod-env`）**：
  `--env-file`（默认 `.env`）逐项 PASS/FAIL，任一 FAIL 退出码 1。九项：`SESSION_SECRET` /
  `LICENSE_HMAC_PEPPER` / `BACKUP_ENCRYPTION_KEY` / `SECRETBOX_KEY` 是否仍是开发默认值（含长度下限 32）、
  `DEPLOYMENT_ENV=production`、`DEV_MAIL_SINK=false`、`SIGNING_KEY_DIR≠.keys`、`APP_BASE_URL` 为 https、
  `LICENSE_DB_URL` 是否仍在用开发口令。**只输出结论**：不打印密钥值、长度、片段；连接串只报 host 性质。
- **验证**：新增 26 条单测（`seed-guard` 8 / `prod-env-check` 10 / `demo-accounts` 8），
  隔离副本 `npm ci` → `tsc --noEmit` exit 0 / `npm test` **335 passed (26 files)** / `npm run build` exit 0、106 静态页；
  临时库实测 seed 三种身份（正常 / 拒绝退出 1 / 豁免放行带横幅）、启动检测两种结果（命中拦截退出 1、清账号后通过）、
  空库降级警告、`check:prod-env` 全 FAIL 与全 PASS 两组输出。
- **部署前必须处理**：现网 `licensing` 库 `users` 表 3 行全是演示账号，本版代码一部署，
  `licensing-saas.service` 下次重启就会被自己的闸门拦下——处置顺序见 `docs/handoff.md` §2.2 首行。
- 记录更新：`README.md` §7、`docs/test-report.md` §1.3（新增验收小节）、`docs/handoff.md` §1/§2.1/§2.2/§2.3。

### 安全 · 生产启动闸门硬拦截 + 全站安全响应头（阶段 1）

阶段 0 实测过一个真问题：`NODE_ENV=production` + `DEPLOYMENT_ENV=development` + 开发默认密钥 +
`DEV_MAIL_SINK=true` 时，服务只打印一行 `[boot] ... 配置检查未通过` 就照常启动。根因是闸门判的是
`DEPLOYMENT_ENV`，而生产构建的身份由 `NODE_ENV` 决定。

- **闸门（`src/instrumentation.ts` / `src/lib/config.ts`）**：新增 `bootMustFail()`，只看
  `NODE_ENV=production`——`bootSafetyIssues()` 非空一律让进程以非零码退出，与 `DEPLOYMENT_ENV` 写什么无关；
  并把「`NODE_ENV=production` 但 `DEPLOYMENT_ENV` 是 development」本身列为一条 issue。
  `sandbox` 故意排除在外：现网 3101 就是 `NODE_ENV=production` + `DEPLOYMENT_ENV=sandbox` 的显式隔离部署，
  另有「`.keys`/`.backups` 不得与生产共用」的独立规则兜底，一并拦会误伤沙箱重启。
- **为什么不是「只 throw」**：Next 16 会吞掉 instrumentation 异常，只打
  `Failed to prepare server ... loading instrumentation hook` 并**继续监听端口**，所有请求回 500，
  systemd 仍显示 `active`、`Restart=on-failure` 不触发（本轮实测）。半活状态比直接死更难发现，
  所以改成「打印完整 issue 清单 + `process.exit(1)`」。判定逻辑仍是纯函数，单测直接覆盖。
- **响应头（`next.config.ts`）**：`poweredByHeader: false`；全站 `/:path*` 下发
  `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy: camera=(), microphone=(), geolocation=()`
  与 `Content-Security-Policy-Report-Only`（先观察，避免内联脚本被打挂；转正式头的四步写在配置注释里）。
  `/metrics` 的令牌校验未改动。
- **验证**：新增 `tests/unit/boot-gate.test.ts` 7 条（四组合 + 沙箱例外 + 沙箱共用目录仍拦）；
  隔离副本 `npm ci` → `tsc --noEmit` exit 0 / `npm run test` 309 passed (23 files) / `npm run build` exit 0、106 静态页；
  反例 `NODE_ENV=production` + `DEPLOYMENT_ENV=development` → `NEG_EXIT=1`、端口未监听、日志列出 5 条 issue；
  正例（专用库/端口 3015）`/login` 与 `/app/dashboard` 均 200 且五个头齐全、`x-powered-by` 命中 0。
- **现网体检（只读，未改环境变量、未重启）**：3100 生产进程的三把密钥与 `DEV_MAIL_SINK`/`DEPLOYMENT_ENV`
  在新闸门下逐项全过、issue 0 条，下次重启不会被拦；3101 沙箱同样 0 条。
- 记录更新：`README.md` §7、`docs/test-report.md` §1.2（新增验收小节）、`docs/handoff.md` §2.1/§2.2/§2.3。
- 顺带发现（未修，留阶段 5）：未登录 `GET /app/dashboard` 返回 200，现网 3100 同样如此——
  登录态是客户端判定的，服务端不拦。

### 构建 · 干净安装不再因 `cpu-features` 构建失败（阶段 0.5）

上一轮（阶段 0）如实登记过一个阻断项：干净副本 `npm install` / `npm ci` 之后 `npm run build`
必然失败，报 `./node_modules/cpu-features/lib/index.js  Error: non-ecmascript placeable asset`。
本轮修掉：

- **根因**：`cpu-features` 是 `ssh2` 的 optionalDependency，`lib/index.js` 静态
  `require('../build/Release/cpufeatures.node')`；干净安装会编译出这个原生 addon，
  Turbopack 无法把 node addon 放进 ESM chunk。本机 `node_modules` 恰好缺该包，所以一直"侥幸"能构建。
- **修法**：`next.config.ts` 增加 `turbopack.resolveAlias`，把 `cpu-features` 指向构建期替身
  `src/lib/shims/cpu-features-noop.cjs`（`module.exports = () => undefined`）。`ssh2` 的调用点是
  `try { cpuInfo = require('cpu-features')() } catch {}`，`cpuInfo` 只影响 cipher 列表微调，
  返回 `undefined` 等价于「该可选包不存在」——即本机既有行为，不是降级。
  `package.json` / `package-lock.json` 未改，`ssh2`、`pg` 均未动。
- **验证**：隔离副本 `npm ci`（exit 0，装了 `cpu-features`）→ `npm run build` exit 0 / 106 静态页；
  `npx tsc --noEmit` exit 0；`npm run test` 302 passed (22 files)；`node -e "require('ssh2')"` 正常；
  对着临时 `atmoz/sftp` 容器跑 `SftpAdapter` 的连接+主机指纹 / 建目录 / 上传 / 下载比对 / 删除五步全 PASS，
  `put`→`get`→`remove` 内容一致；构建产物 `next start` 起在 3013（专用库）`/health/ready` 200。
- 记录更新：`docs/test-report.md` §1.1 从「未修」改为「已修复」并保留复现档案，
  `docs/handoff.md` §1/§2.1/§2.2、`README.md` §1.2 同步。

### 文档 · 数字与实测对账

上线前把文档里的数量类表述全部按本轮实测重写，并补上一直漏掉的 Prisma Client 生成步骤：

- **数字全部重测**：单元测试 302 个 / 22 个文件（旧文写 75 个 / 7 个文件或 66 个）、
  集成测试 12 个、端到端 16 个 / 7 个文件、静态页 106/106（旧文写 91/91 或 88/88）、
  页面路由 49 个（旧文 46）、API 路由 74 个、`route.ts` 合计 82 个（旧文 66/71/76）。
  `README.md`、`docs/handoff.md`、`docs/test-report.md`、`docs/api.md` 四处同步，每处数字旁
  都写明统计命令或口径，可直接复跑核对。
- **`npx prisma generate` 补进上手步骤**：`prisma/schema.prisma` 的 generator 输出到
  `src/generated/prisma`，该目录被 `.gitignore` 排除，`npm install` 也不会自动补（刻意没挂
  `postinstall`）。README §1.2 与 `docs/handoff.md` §3.1 都加上了这一步并说明缺它的症状
  （`typecheck` 报 `Cannot find module '@/generated/prisma/...'`、部分单测失败）。
- **如实记录两条端到端失败**：`tests/e2e/05-backups.spec.ts` 的「被策略引用的目标不允许直接删除」
  与「立即备份 → 完整性校验 → 隔离恢复演练」在**纯净种子**下必然失败——`prisma/seed.ts` 不创建
  备份目标与策略，而这两条用例假定已存在。早期「16 passed」是在跑过多轮 e2e 的脏库上得到的。
  本轮只记录不修（属于测试/种子数据问题，留待后续阶段），`docs/test-report.md` 新增 §4.7
  写明根因与两种修法。
- 顺带修正：`docs/api.md` 把 v1.5 新增公开端点从「三个」改为四个（补上
  `POST /v1/server/licenses/check`，它一直在契约与实现里）；`docs/test-report.md` 的
  `backup.test.ts` 用例数 15 → 26 并补齐后三组（`backupObjectKey` / WebDAV MKCOL / 上传重试）；
  `04-routes.spec.ts` 覆盖路由 21/22 → 23 条；导航遍历 17 → 16 项。
- **如实记录一个更严重的构建缺陷**（阶段 0 时未修，**阶段 0.5 已修复**，见上方「构建 · 干净安装不再因 `cpu-features` 构建失败」）：干净副本上 `npm install` / `npm ci` 之后
  `npm run build` **必然失败**，报
  `./node_modules/cpu-features/lib/index.js  Error: non-ecmascript placeable asset`。
  `cpu-features` 是 `ssh2` 的 optionalDependency，带原生 addon `cpufeatures.node`；SFTP 备份适配器
  静态 import `ssh2`，链路经 `src/instrumentation.ts` 被 Edge instrumentation 拉到，Turbopack 无法
  把 node addon 放进 ESM chunk。本机 `node_modules` 里恰好没有这个包（当初编译失败被跳过），
  所以本地构建一直能过——**「构建成功」这个结论只在现有依赖树上成立**。
  `serverExternalPackages` 实测无效；`npm install --omit=optional` 也会连带移除 `pg` 的 optional
  依赖 `pg-cloudflare`，build 改报 `Module not found: Can't resolve 'pg-cloudflare'`。
  尚未试的是 `turbopack.rules` 单独标 external 或 `overrides` 只剔除这一个包，属构建配置改动，
  本轮（阶段 0 只做文档对账）不动。
  `docs/test-report.md` 新增 §1.1 记录复现步骤、真实报错与 import trace，
  `docs/handoff.md` §2.2 与 `README.md` §1.2 各加一条醒目提示。

### 安全 · 公开发布前清理

把本机专属的标识从代码与文档里彻底剥离，仓库可以安全公开托管：

- 文档中的真实域名 / 公网 IP / 备份账号口令替换为 `[HOST]` / `[OFFSITE_HOST]` /
  `[BK_USER]` / `[BK_PASS]` / `<你的域名>` 等占位符（10 个文件、66 处）。
- `prisma/seed.ts` 的 14 个演示客户改为「示例客户 NN」，邮箱统一走 RFC 2606 的
  `.example`；激活记录里的真实公网 IP 换成 RFC 5737 TEST-NET-3 地址。
- 删除 `docs/shots/`（31 张 7.0M）：截图含真实客户名与登录页明文口令，而 seed
  已改为虚构数据，重生成要重跑 seed 会清空生产库，因此直接移除；三处引用改为
  「本地跑起来自己截」。
- 删除 10 条 `.windsurf/skills/*` 符号链接（clone 后必然断链）并写入 `.gitignore`。
- 登录页的演示账号提示块加 `NODE_ENV !== "production"` 守卫：production 构建会
  整块摇掉（已在 `.next` 产物里复查无残留），开发时仍可见。
- 新增 `.gitattributes`（`* text=auto eol=lf`），避免 Windows 上 clone 把 `.sh`
  转成 CRLF 后 Linux 报 `bad interpreter: /bin/bash^M`。
- `package.json` 补 `license: UNLICENSED` 与 `engines.node >= 22`；新增 `LICENSE`。
- 单元测试与 SDK 示例里的真实域名 / IP 一并换成 `example.com` 与 TEST-NET。
- 以上清理同时重写了 git 历史（`filter-branch --tree-filter`），保证任何历史提交
  都取不出原始值。

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
