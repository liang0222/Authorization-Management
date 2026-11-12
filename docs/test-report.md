# 测试报告

本文件只记录**实际执行过**的结果。凡是「未执行」都明确写出，不把类型检查当功能验证。

执行环境（本轮实测，2026-11）：

```
Node v26.13.0 / npm 11.20.0
PostgreSQL 16（Docker 容器 licensing-pg，127.0.0.1:55432）
Next.js 16.4.3（生产构建 next start -p 3001 / 开发 next dev -p 3000）
Playwright 1.64.1（Chromium 1248）
```

> 上一版这里写的是 `Node v24.22.0 / npm 12.2.1`，是更早一次执行的机器环境；本轮全部数字都按
> 上面的版本重跑过，下面的「结果」列与之一一对应。

---

## 1. 总览

| 层级 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 类型检查 | `npm run typecheck`（= `tsc --noEmit`） | **0 错误** | ~20s |
| OpenAPI lint | `npm run lint:openapi` | **通过**（结构 / schema / servers / 凭证泄漏 / YAML↔JSON 同步） | ~1s |
| 生产构建 | `npm run build` | **成功，106/106 静态页**；路由表 132 条 = 40 ○ + 5 ◐ + 87 ƒ（干净副本 `npm ci` 后同样通过，见 1.1） | ~50s |
| 单元测试 | `npm run test`（= `npx vitest run`） | **302 passed (22 files)** | 3.1s |
| 集成测试 | `npx vitest run -c vitest.integration.config.ts` | **12 passed** | 15.4s |
| 端到端 | `npx playwright test` | **16 tests in 7 files：14 passed / 2 failed** | 2.7m |

> 端到端那 2 条失败见第 4 节末尾「纯净种子下的两条失败」——是真实差异，不是环境噪音。
> 上一版写「16 passed」是在跑过多轮 e2e 的脏库上得到的。
>
> 生产构建那一行在**现有依赖树**与**干净副本**（`npm ci` 全新安装）上都通过了。
> 干净安装曾因 `ssh2` → `cpu-features` 原生 addon 必然失败，阶段 0.5 已修复，复现与验证见 1.1 节。

数字口径（都可直接复跑）：

| 数字 | 命令 |
| --- | --- |
| 单元 302 / 22 文件 | `npx vitest run` → `Test Files 22 passed (22) / Tests 302 passed (302)` |
| 集成 12 / 1 文件 | `npx vitest run -c vitest.integration.config.ts`（先 `npm run db:seed`） |
| 端到端 16 / 7 文件 | `npx playwright test --list` → `Total: 16 tests in 7 files`（含 1 条 setup） |
| 静态页 106 | `npm run build` → `✓ Generating static pages using 3 workers (106/106)` |
| 页面 49 | `find src/app -name 'page.tsx' \| wc -l` |
| API 路由 74 / route handler 82 | `find src/app/api -name 'route.ts' \| wc -l` / `find src/app -name 'route.ts' \| wc -l` |

### 1.1 干净安装后 `npm run build` 会失败（阶段 0 实测，阶段 0.5 已修复）

> **现状（阶段 0.5 之后）**：干净副本 `git archive` → `npm ci`（exit 0，装了 `cpu-features` 并编译出
> `cpufeatures.node`）→ `npx prisma generate` → `npm run build` **exit 0，106/106 静态页**。
> 修法见本节末尾「修复」；下面保留阶段 0 的复现记录，作为该缺陷的档案。

上面「生产构建成功」那一行是在**本机现有 `node_modules`** 上跑出来的。为了验证「新克隆一台机器能不能起来」，
本轮另建了两份隔离副本（`git archive HEAD` + 打上本轮文档 diff），分别用 `npm install` 和 `npm ci` 全新安装，
结果 **build 都失败**，且可稳定复现：

```
> licensing-saas@0.1.0 build
> node scripts/copy-api-reference.mjs && next build

▲ Next.js 16.4.3 (Turbopack)
  Creating an optimized production build ...
Turbopack build encountered 27 warnings:
...

> Build error occurred
Error: Turbopack build failed with 1 error:
./node_modules/cpu-features/lib/index.js
Error: non-ecmascript placeable asset
[project]/node_modules/cpu-features/build/Release/cpufeatures.node (node addon) is not placeable in ESM chunks,
so it doesn't have a module id and can't be imported here. Only modules that are compiled to JavaScript can be imported.

Import traces:
  externals-tracing:
    ./node_modules/cpu-features/lib/index.js [externals-tracing]
    ./node_modules/ssh2/lib/protocol/constants.js [externals-tracing]
    ./node_modules/ssh2/lib/client.js [externals-tracing]
    ./node_modules/ssh2/lib/index.js [externals-tracing]
    [externals]/ssh2 [external]
    ./src/lib/services/backup/adapters/sftp.ts [App Route]
    ./src/lib/services/backup/factory.ts [App Route]
    ./src/app/api/v1/admin/backups/destinations/[id]/test/route.ts [App Route]
  Edge Instrumentation:
    ./node_modules/cpu-features/lib/index.js
    ...
    ./src/instrumentation.ts
```

- **根因**：`cpu-features` 是 `ssh2` 的 `optionalDependencies`（`node_modules/ssh2/package.json`：
  `"optionalDependencies": {"cpu-features": "~0.0.10", "nan": "^2.23.0"}`）。它带一个原生 addon
  `build/Release/cpufeatures.node`，一旦安装并编译成功，Turbopack 就会在打包 `ssh2` 时踩到它并报
  `non-ecmascript placeable asset`。SFTP 备份适配器（`src/lib/services/backup/adapters/sftp.ts`）
  静态 import 了 `ssh2`，这条链一路被 `src/instrumentation.ts` 的 Edge instrumentation 拉到。
- **为什么本机能 build**：本机 `node_modules/cpu-features` 根本不存在（`npm ls cpu-features` → `(empty)`，
  `require.resolve` 报 `MODULE_NOT_FOUND`）——当初安装时这个可选依赖编译失败被跳过了，本机是**侥幸**成功。
  干净安装（`npm install` 与 `npm ci` 都验过）会把它装上并编译成功，于是必然失败。
- **验证**：把副本里的 `node_modules/cpu-features` 移走后 build 立刻成功
  （`✓ Compiled successfully in 3.3s`、`✓ Generating static pages using 3 workers (106/106)`）；
  移回后再次 `BUILD_EXIT=1`，同样报错。即确定性复现，不是偶发。
- **试过但无效的修法**（都是实测，不是推测）：
  1. `next.config.ts` 加 `serverExternalPackages: ["ssh2", "cpu-features"]` → 仍然
     `non-ecmascript placeable asset`，该选项对 Turbopack 打包 node addon 不生效。
  2. `npm install --omit=optional` → `cpu-features` 确实被移除了，但 **`pg` 的 optionalDependency
     `pg-cloudflare` 也一起被移除**，build 改报另一个错：
     `./node_modules/pg/lib/stream.js:41:34  Error: Module not found: Can't resolve 'pg-cloudflare'`。
     即 `--omit=optional` 不能作为整体方案。
  3. `.npmrc` 写 `optional=false` 与 2 同因同果（都是全局关闭 optional 依赖），不解决。

**修复（阶段 0.5）**：用 Next 16 支持的 `turbopack.resolveAlias` 在**构建期**把 `cpu-features`
替换成空实现，node_modules 与锁文件都不动：

```ts
// next.config.ts
turbopack: {
  resolveAlias: { "cpu-features": "./src/lib/shims/cpu-features-noop.cjs" },
  rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
}
```

替身内容就一行 `module.exports = () => undefined;`。能这样修的前提是 `ssh2` 的调用点本身是
`try { cpuInfo = require('cpu-features')(); } catch {}`（`node_modules/ssh2/lib/protocol/constants.js:5-8`），
`cpuInfo` 只用来微调 cipher 列表（`constants.js:93` / `:99`）。返回 `undefined` 等价于「该可选包不存在」，
也就是**本机当前依赖树下的既有行为**，不是新引入的降级。

验证（隔离副本 `/root/s05`，全新 `npm ci` 装出 `cpu-features` 与 `cpufeatures.node`）：

| 检查 | 结果 |
| --- | --- |
| `npm ci` | exit 0（1038 packages，仍会装 `cpu-features@0.0.10`） |
| `npm run build`（修复前） | **exit 1**，`non-ecmascript placeable asset` |
| `npm run build`（修复后） | **exit 0**，`✓ Compiled successfully in 3.7s`，`✓ Generating static pages (106/106)` |
| 产物核对 | `.next` 中 `cpufeatures.node` 仅出现在 sourcemap 里；14 个产物文件引到替身 `cpu-features-noop` |
| `npx tsc --noEmit` | exit 0 |
| `npm run test` | `Test Files 22 passed (22) / Tests 302 passed (302)` |
| ssh2 加载 | `node -e "require('ssh2')"` → `Client= function Server= function utils= object` |
| SFTP 真实往返 | 对着临时 `atmoz/sftp` 容器：连接+主机指纹 / 建目录 / 上传 / 下载比对 / 删除 五步全 OK；`put`→`get`→`remove` 内容一致 |
| 构建产物运行 | `next start` 起在 3013（专用库）：`/health/ready` 200，`/login` 200 —— 说明 bundle 里 `ssh2` 的 `constants.js` 在替身下正常求值 |

**对本节其它结论的影响**：`typecheck`、`lint:openapi`、`test`、集成测试在干净副本上都是绿的
（302 单元 / 12 集成，与主仓库一致）。修复后 `build` 在干净安装与现有依赖树上都能过，
「新机器照 README 装完就能 build」这一条**现在成立**。

---

## 2. 单元测试（302 个 / 22 个文件）

只测纯函数与领域规则，不碰数据库、不 mock 业务分支。

逐文件用例数（`npx vitest run --reporter=json` 统计 `assertionResults.length`，合计 302）：

| 文件 | 用例数 | 文件 | 用例数 |
| --- | --- | --- | --- |
| `tests/unit/installer-store.test.ts` | 28 | `tests/unit/backup-retention.test.ts` | 26 |
| `tests/unit/backup.test.ts` | 26 | `tests/unit/installer-manifest.test.ts` | 20 |
| `tests/unit/installer-config-writer.test.ts` | 18 | `tests/unit/cron.test.ts` | 17 |
| `tests/unit/installer-database.test.ts` | 17 | `tests/unit/cursor.test.ts` | 16 |
| `tests/unit/effective-status.test.ts` | 15 | `tests/unit/period.test.ts` | 14 |
| `tests/unit/outbound-url.test.ts` | 14 | `tests/unit/installer-state.test.ts` | 13 |
| `tests/unit/developers-base-urls.test.ts` | 12 | `tests/unit/installer-lock.test.ts` | 12 |
| `tests/unit/license-key.test.ts` | 10 | `tests/unit/llms.test.ts` | 9 |
| `tests/unit/deployment-environment.test.ts` | 8 | `tests/unit/signing-key.test.ts` | 8 |
| `tests/unit/openapi.test.ts` | 7 | `tests/unit/secretbox.test.ts` | 6 |
| `tests/unit/activation-token.test.ts` | 5 | `tests/unit/openapi-lint.test.ts` | 1 |

### 2.1 `tests/unit/period.test.ts`（14 个）

覆盖规格 0.1 的标准周期：

- 7 / 15 / 30 天按 `day` 精确加天；
- 一季度 = `month 3`、一年 = `month 12`，**不是** 90/365 天；
- 自然月跨月末钳制：`2026-01-31 + 1 个月 = 2026-02-28`、`2026-01-31 + 3 个月 = 2026-04-30`；
- 闰年 `2024-02-29 + 12 个月 = 2025-02-28`；
- 永久授权 `{unit:"lifetime", value:0}` 返回 `null`（`expires_at` 为 NULL）；
- 时区敏感：`Asia/Shanghai` 与 `UTC` 下同一时刻的月末判定一致；
- `formatDuration` 对 3 个月输出「一季度（3 个自然月）」、12 个月输出「一年（12 个自然月）」；
- `renewalStart`：未到期从 `expires_at` 顺延、已过期从 `server_now` 起算。

### 2.2 `tests/unit/effective-status.test.ts`（15 个）

覆盖规格 3.2 的优先级链：

```
product_disabled → revoked → cancelled → suspended → draft
→ activation_window_expired → not_yet_valid → expired → active
```

重点断言：

- 产品停用优先于一切状态（即使授权本身 revoked，也显示 `product_disabled`）；
- `revoked`/`cancelled` 是终态，任何其它条件不能覆盖；
- `activation_limit_reached` / `device_limit_reached` **只影响新激活**，不影响
  `usable`（已激活设备仍可心跳）；
- `availableAdminActions` 对终态返回空数组，对 suspended 返回 `["resume","revoke"]` 等。

### 2.3 `tests/unit/license-key.test.ts`（10 个）

- 授权码格式：5 组 × 6 位 Crockford Base32，总长 34（含 4 个连字符），排除 `I/L/O/U`；
- 1 万次生成无重复；
- `normalizeLicenseKey` 容忍空格、小写、连字符缺失，并把 `I/L→1`、`O→0`；
- `hashLicenseKey` 同输入同输出（HMAC 稳定），换 pepper 则不同；
- `maskLicenseKey` 输出 `••••-••••-••••-3456`；
- 凭证前缀：公开客户端 `pc_`、机密服务端 `cs_`；
- `ROLE_PRESETS` 里的权限码全部存在于 `ALL_PERMISSION_CODES`；
- `NAV_GROUPS` 里每个 `permission` 也是合法权限码（防导航写出不存在的权限）。

### 2.4 `tests/unit/activation-token.test.ts`（5 个）

- 签发 → 验签通过；
- 篡改载荷 → `invalid_signature`；
- 篡改签名 → `invalid_signature`；
- 过期（TTL 为负）→ `reason: "expired"`；
- 空值/畸形输入 → `reason: "malformed"`；
- `canonicalChallengeMessage` 五字段换行顺序固定，字段顺序变化则签名不通过。

### 2.5 `tests/unit/backup.test.ts`（26 个，v1.5 新增）

备份模块里不需要数据库就能验证的六块纯逻辑：

加解密（6 个）：
- 往返后字节完全一致（含 `\u0000` 二进制）；
- 同一明文两次加密结果不同（IV 随机），SHA-256 也不同；
- 头部魔数是 `ZMBK1`，且密文里搜不到明文；
- 翻转密文最后一个 bit → GCM 认证失败直接抛错；
- 非备份包文件在解密前被魔数拦住（报错含「魔数」）；
- `sha256Hex` 与 Node 原生 digest 逐字符一致（写死 `ba7816bf…20015ad`）。

作业状态判定 `decideJobStatus`（6 个）：
- `all_required`：全成功 `succeeded`、部分成功 `partial`、全失败 `failed`；
- 可选目标失败不影响结论（只统计必需目标）；
- `primary_then_fallback`：主成功即 `succeeded`；
- **主失败、备成功必须标 `degraded`**，不能算 `succeeded`；
- `quorum`：达到阈值 `partial`、未达到 `failed`、全成功 `succeeded`；
- 空结果集不会假装成功（`failed`）。

调度与保留（3 个）：
- 接受 `0 3 * * *`、`*/15 9-17 * * 1-5`；
- 拒绝 4 段 / 6 段 / 月份写 `MON` / 空串；
- 保留策略有上下界（`daily` 1–365、`weekly` 0–104、`monthly` 0–120）。

远端对象键 `backupObjectKey`（4 个，防前缀双拼回归）：
- 有 `remote_prefix` 时只拼一次；
- 前后斜杠被归一，不产生双斜杠；
- 没有 `remote_prefix` 时只留文件名，不以斜杠开头；
- 前缀里出现重复时**不做二次拼**（这就是当年的 bug 形态）。

WebDAV MKCOL 尾斜杠重定向识别（4 个）：
- 同源、路径相同、只多了尾斜杠 → 视为目录已存在（不算失败）；
- 跨主机一律拒绝（哪怕路径一模一样，防被 3xx 带去别处）；
- 同源但路径不同 → 拒绝（不是 `DirectorySlash` 那种情况）；
- 缺失或非法的 `Location` → 拒绝。

上传重试判定（3 个）：
- 超时、连接重置、DNS 抖动都算可重试；
- 服务端明确拒绝不算可重试（重试只会重复失败）；
- 尝试次数是 2：够覆盖偶发抖动，又不会把作业拖长。


### 2.6 `tests/unit/openapi.test.ts`（7 个，v1.5 新增）

契约与代码必须双向一致，否则「能解析」会伪装成「已对齐」：

- 是 OpenAPI 3.1 文档并声明了服务器地址；
- **每个 path 都有真实路由文件**（把 spec 里的 path 还原成 `src/app/api/v1/**/route.ts` 去存在性检查）；
- **每个公开路由都被 spec 覆盖**（反向：扫代码里的 route.ts，排除 admin/auth/status，动态段 `[id]` → `{id}` 后比对）；
- `operationId` 唯一，且每个操作都声明了响应与错误；
- 所有 `$ref` 都能解析；
- 每个操作都声明了安全方案；
- 生成的 `openapi.json` 与 `openapi.yaml` 内容一致（防止两份手改漂移）。

这一组在 P1-1 加了三个新端点后立刻失败过 —— 报出「代码里存在但 spec 未覆盖的公开端点」三条，
补齐 spec 后才转绿。契约测试的价值就在这里：它拦住的是「接口加了、文档没加」。

### 2.7 `tests/unit/llms.test.ts`（9 个，v1.5 新增）

`llms.txt` / `llms-full.txt` 是给 AI 编程工具读的，一旦和真实契约脱节，AI 会照着过时端点写代码。
所以这两个文件不再手写，全部从代码与契约派生，测试负责守住「派生」这件事：

- 端点清单与 OpenAPI `paths` 完全一致（正则抓 `- METHOD /path` 后正反双向比对）；
- 临时往 spec 里加一条 path，生成结果里**自动出现**该端点（证明是派生不是抄写）；
- 限流数值逐条来自 `PUBLIC_RATE_LIMITS`；
- Webhook 事件逐条来自 `WEBHOOK_EVENT_TYPES`，且数量一致；
- 公开错误码覆盖 `ERROR_STATUS` 里的对外码，且**不泄露控制台专用码**；
- 推荐阅读顺序来自 `DOCS_SECTIONS` 且序号连续；
- 两文件都不含密钥样式（`BEGIN … PRIVATE KEY`、`sk_`、`whsec_`、三段式 JWT、`XXXX-XXXX` 形授权码）；
- 列出全部机器可读文件（含 `ai-integration-prompt.md`）。

两处**假断言**在这里被抓出来并改掉，值得记一笔：

1. 判断「不泄露 `CONFLICT`」时若直接对全文 `toContain("CONFLICT")`，
   会被 `IDEMPOTENCY_CONFLICT` 命中而失败——反过来若写成「不包含」，
   同样会被这个子串关系骗过去。正确做法是**只取「## 8. 错误码」这一节**再逐行比对。
2. 端点行一开始用 `padEnd` 做了列对齐，导致 `grep "GET /activations/{activation_id}"` 与测试断言
   都匹配不上。最后取消对齐：单空格形式可被原样搜索，比好看重要。

### 2.8 一条被编译期抓出来的真缺陷

给错误码文档页写 `Record<keyof typeof ERROR_STATUS, …>` 想逼出「新增码必须补文案」时发现：
`ERROR_STATUS` 原本声明为 `Record<string, number>`，于是 `keyof typeof ERROR_STATUS` 退化成 `string`，
**这个检查是假的**——少写几个键照样通过编译。

修法是把源头改成字面量对象 + `as const` 并导出 `ErrorCode` 联合类型。
改完 `npx tsc --noEmit` 立刻报 `Type ... is missing the following properties: CSRF_FAILED, CONFLICT`，
确实是漏写的两条。补上后 21 个错误码全部有文案。

教训：**`Record<string, T>` 会吃掉键的字面量信息**，所有依赖 `keyof` 的完整性检查都要先确认源头不是宽类型。

---

## 3. 集成测试（12 个）

`tests/integration/api.test.ts`：**真实打 HTTP 服务 + 真实 PostgreSQL**，不 mock 任何一层。
运行前需 `npm run db:seed`（会 TRUNCATE 后重灌种子数据）。

| # | 用例 | 断言要点 |
| --- | --- | --- |
| 1 | 错误密码 vs 不存在的邮箱 | 都返回 `401 CLIENT_AUTH_FAILED`，`message` 完全一致（均为「邮箱或密码不正确」）——防账号枚举 |
| 2 | 未登录访问管理接口 | `401 CLIENT_AUTH_FAILED` |
| 3 | 写操作缺 `x-csrf-token` | `403 FORBIDDEN` |
| 4 | 签发 → 暂停 → 恢复 → 撤销 → 再恢复 | 撤销后任何动作 `409`（终态不可变） |
| 5 | 撤销后尝试续费 | `409` |
| 6 | 续费 `mode="append"` | 新 `expires_at` = 原值 + 30 天（误差 < 5s） |
| 7 | `audit@xinglan.dev`（viewer）尝试签发 | `403 FORBIDDEN` |
| 8 | 永久授权续费 | `400 INVALID_REQUEST` |
| 9 | 完整激活链路 | 激活 `201` → 心跳 `200` 且 token 轮换 → 旧 token `401` → entitlements `200` → 解绑 `released:true` → 详情 `activeDevices=0`、`activationCount=1`（默认不返还次数） |
| 10 | 幂等 | 同键同体重放带 `x-idempotent-replay: true` 且 `activation_id` 相同；同键异构体 `409 IDEMPOTENCY_CONFLICT` |
| 11 | 并发 / 暂停后心跳 | `max_devices=1` 两设备并发结果恒为 `[201, 409 DEVICE_LIMIT_EXCEEDED]`，活跃设备数 1；暂停后心跳 `423 LICENSE_SUSPENDED` |
| 12 | **管理端改功能覆盖 → 心跳看到版本自增**（v1.5 新增） | 激活后 `entitlements_version=1` → 心跳拿到 v1 与旧值 → 管理端 `PUT /admin/licenses/{id}/features` 覆盖一个布尔功能 → 断言 v2 且值已变 → **第二次心跳断言 v2 与新值**（这是「客户端据此决定要不要重拉权限」的核心主张）→ 清空覆盖断言 v3 并回落到套餐默认 → 越权账号 `403` → 类型不符 `422 FEATURE_VALUE_INVALID` → 未知功能码 `422 FEATURE_NOT_FOUND` |

第 12 条特意挑 `valueType === "boolean" && status === "active"` 的**真实功能**（不写死功能编码），
因为写死编码会让种子数据一改测试就失败，而失败原因看起来像「功能被删了」。

**并发用例的稳定性（本轮更正）**：上一版这里写「连续执行 6 次，5 次全绿，判断为环境偶发」。
本轮复跑后确认**不是偶发，而是对库状态敏感**，且失败形态有两种：

| 库状态 | 结果 | 失败断言 |
| --- | --- | --- |
| 干净种子（`npm run db:seed` 之后立刻跑） | 12 passed | — |
| 已跑过一轮集成/e2e 的脏库 | 1 failed / 11 passed | `expected [ 429, 429 ] to deeply equal [ 201, 409 ]`——上一轮把登录/激活的进程内限流计数打满，两次并发激活都先撞 429 |
| 再跑一轮 | 4 failed / 8 passed | 上面那条 + `expected null to be 'true'`（`x-idempotent-replay` 头缺失，幂等记录被上一轮的同键请求占用） |

即**用例本身正确**（干净状态下它确实断言 `[201, 409]` 且通过），但它依赖「库与限流窗口都是干净的」这个前提，
而限流是进程内计数、只有重启服务或等窗口过去才清零。所以：

- 集成测试必须在 `npm run db:seed` 之后、且**服务刚起或窗口已过**时跑；
- 连跑第二次必然变红，不要把它当回归信号；
- 本轮在隔离副本（新建库 + 干净种子 + 新起实例）上重跑，稳定 `12 passed (12)`，与主仓库结论一致。

要彻底解决需要把限流/幂等换成 Redis（多实例部署那条已在 8 节列为未验证），不在本轮范围。

**两处为了让测试稳定而改的产品代码**（都是真实改进，不是为测试绕过）：

1. 登录接口限流改为「只对失败计数」，否则测试自己的连续登录会被打成 429；
2. 授权列表 `q` 增加 `OR l.id::text ILIKE $n`，使「按授权 ID 片段检索」成为真实能力。

---

## 3.5 多语言示例实测（v1.5）

`docs/v15-audit.md` 的 P0-8 要求「Python / PHP / Node 示例必须真实请求并覆盖成功与错误」，
P1-4 追加 Go / Java / C#。这一节记录的是真实执行输出，不是「代码看起来对」。

环境：dev server `http://127.0.0.1:3000`，`fluxpanel-desktop` 产品的测试授权，
设备密钥目录 `/tmp/ziming-sdk-verify/<语言>`。
工具链：Python 3.11（cryptography 38.0.4）、Node 24、PHP 8.2.32（ext-curl + ext-sodium）、
Go 1.19.8、OpenJDK 17.0.19、Mono 6.8.0.105 + BouncyCastle.Cryptography 2.6.2。

### 3.5.1 一条命令跑完六个（`sdk-examples/verify.mjs`）

```
已把授权限额抬到 maxDevices=50 / maxActivationCount=500（便于反复运行）
PASS python 0.6s
… 等待 12s（避开 /activations 的 10 次/60 秒限流）
PASS node   0.4s
…
PASS go     0.6s
PASS java   1.1s
PASS csharp 0.7s

6/6 全部通过
```

六个语言的成功路径都打印 `effective_status: active`、同一组 entitlements、心跳 `version=1 next=900s`；
失败路径都以 `LICENSE_INVALID` 收尾（Python/Node/PHP 打「预期失败」、Go/Java/C# 打「已被拒绝（预期）」）。

| 语言 | 额外依赖 | 结论 |
| --- | --- | --- |
| Python 3.11 | `cryptography` | PASS |
| Node 24 | 无（`node:crypto`） | PASS |
| PHP 8.2 | `ext-sodium` | PASS |
| Go 1.19 | 无（`crypto/ed25519`） | PASS |
| Java 17 | 无（`java.net.http` + `java.security`） | PASS |
| C# / Mono | BouncyCastle.Cryptography 2.6.2 | PASS |

> **状态标 `Preview`，不是 `Stable`。** 这六个目录是可运行示例，没有发布到任何包管理器
> （PyPI / npm / Packagist / Go module proxy / Maven Central / NuGet）。按规格 27.17，
> 只有真正发布了才能标 Stable。

### 3.5.2 验收脚本自己踩的限流坑

第一版 `verify.mjs` 不留间隔连跑六个语言，第 6 个直接 `RATE_LIMITED`：

```
Quickstart+RateLimitException: RATE_LIMITED: 请求过于频繁，请在 15 秒后重试
```

原因不是 SDK：每个示例都打两次 `/activations`（成功 + 失败路径），六个语言共 12 次，
而公开限流是 `/activations` **每产品 10 次 / 60 秒**。修法是脚本自己按 12 秒间隔铺开，
并额外做一次「撞到 429 就按 `retry-after` 等一轮再重试」。
`LICENSE_VERIFY_GAP_MS=0` 可以关掉间隔，然后就能亲眼看到 429——限流是工作的，不是坏了。

### 跑通过程中修掉的两个真实缺陷

**1. 三种语言共用同一个密钥文件 → PHP 读到 Python 写的 DER 密钥**

症状：
```
PHP Fatal error: Uncaught SodiumException:
sodium_crypto_sign_publickey_from_secretkey(): Argument #1 ($secret_key)
must be SODIUM_CRYPTO_SIGN_SECRETKEYBYTES bytes long
```
原因：三个示例都用 `$KEY_DIR/ziming-example-device.key` 做文件名，但编码完全不同 ——
Python 写的是 DER PKCS8（48 字节），PHP 用的是 sodium 的 64 字节 secret。先跑 Python 再跑 PHP，
PHP 就把 Python 的文件当成自己的密钥读了。
修法：文件名带语言后缀（`…-device.sodium`），且读取后校验
`strlen($secret) === SODIUM_CRYPTO_SIGN_SECRETKEYBYTES`，长度不符就重新生成。

**2. PHP 的裸公钥不是 SPKI，服务端直接拒**

症状：`400 INVALID_REQUEST: public_key 必须是 base64url 编码的 Ed25519 SPKI 公钥`。
原因：`sodium_crypto_sign_publickey_from_secretkey()` 返回 32 字节裸公钥，
而服务端按规格要 44 字节 SPKI DER（`302a300506032b6570032100 || key`）。
修法：PHP 里补上固定前缀 `\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00`。

> 这两个坑正是「示例必须真跑」的价值：只看代码，两处都完全合理；
> 只有真发一次请求，才会知道服务端要的是 SPKI 而不是裸公钥。

---

## 4. 端到端测试（16 个）

`playwright.config.ts` 起 `next start -p 3001`，三个 project：

- `setup`：调真实登录接口，把 storageState 存到 `tests/e2e/.auth/owner.json`；
- `chromium`：桌面 1280×720；
- `mobile`：Pixel 7（412×915），只跑 `responsive.spec.ts`。

### 4.1 `01-auth.spec.ts`（3 个）

1. 未登录访问 `/app/licenses` → 跳 `/login?next=%2Fapp%2Flicenses`（断言 `$` 锚定，
   否则会误命中查询串里的 `%2Fapp%2Flicenses`）；
2. 错误密码 → 提示「邮箱或密码不正确」，不泄露账号是否存在；
3. 正确凭据 → 进入 `/app/licenses` 且 h1 为「授权管理」→ 打开账户菜单 → 退出登录。

### 4.2 `02-navigation.spec.ts`（2 个）

1. **16 个导航项逐项点击**：断言 URL、h1 可见、没有落到 Next 的 404/错误页，
   并收集浏览器 console error 与 pageerror，最后断言**数组为空**；
2. 折叠侧栏 → 只剩图标（按钮名变「展开侧栏」）→ 刷新后仍保持折叠（localStorage 持久化）。

### 4.3 `03-license-issue.spec.ts`（2 个）

1. 点「签发授权」→ Drawer 内选产品与客户 → 提交 → 断言「授权已签发」→ 读取兑换码并
   校验正则 `^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){4}$` → 用后四位搜索能查到；
2. 未选产品/客户时提交按钮 `disabled`。

### 4.4 `04-routes.spec.ts`（1 个，覆盖 23 条路由）

**这是本轮新增的用例，起因是一次真实事故**：`/app/products/[id]` 在把接口返回的
`counts.licenseByStatus`（对象）当成数组 `.map` 时抛
`TypeError: counts.licenseByStatus.map is not a function`，整页只剩
「This page couldn't load」。导航用例只点列表页，因此完全没发现。

用例做法：

1. 用同一个 storageState 的 `request` 现场取真实 id（授权 / 产品 / 客户 / Webhook），
   不把 uuid 写死；
2. 逐条 `page.goto(route, { waitUntil: "networkidle" })`，断言 `h1` 可见且命中预期文案；
3. 同时挂 `pageerror`、`console`、`response` 三个监听器，任何 4xx/5xx、未捕获异常、
   console error 都记入问题清单（只放行登录态探测的 401 与 favicon）；
4. 最后 `expect(problems).toEqual([])`，失败时把全部问题路由一次列出来。

覆盖（数组实测 23 条，`grep -c 'path:' tests/e2e/04-routes.spec.ts` 的数组区间内计数）：
`/app/dashboard`、`/app/products`、`/app/products/[id]`、`/app/customers`、
`/app/customers/[id]`、`/app/plans`、`/app/features`、`/app/licenses`、`/app/licenses/[id]`、
`/app/devices`、`/app/developer/{api,credentials,webhooks,webhooks/[id]}`、
`/app/security/{signing-keys,verification-logs,audit-logs}`、
`/app/settings/{members,organization,system,profile}`，v1.5 追加
`/app/settings/backups`，共 23 条。

另外用 `audit@xinglan.dev`（viewer）手工跑了一遍同样的 16 条导航路由，
全部渲染正常、无 white screen，越权页面落到「没有…权限」空态而不是报错。

### 4.5 `responsive.spec.ts`（2 个，mobile project）

1. 汉堡按钮 → `dialog[name="主导航"]` 出现 → 点「激活设备」→ URL 变化且抽屉自动关闭；
2. 移动端列表页保留搜索框与「签发授权」按钮。

### 4.6 `05-backups.spec.ts`（5 个，v1.5 新增）

备份页不是「点开看看」，每一步都验证真实副作用：新增目标会写库、连接测试真的往磁盘
写一次再读回比对再删除、立即备份跑一次 `pg_dump`、恢复演练建临时库灌数据再对账。

1. **五块渲染真实数据**：概览 / 存储目标 / 备份策略 / 作业历史 / 恢复演练都在；
   `RPO / RTO` 精确匹配（页面上还有一句同名说明文字，必须 `{ exact: true }`）；
   WAL 状态必须明写「未启用」，不允许含糊成「已具备 PITR」；
2. **新增目标 → 连接测试 → 删除**：不填名称直接提交必须被前端拦住（断言弹窗内出现
   「请填写名称」，不发出非法请求）→ 填名称选「本地暂存」→ 创建后行显示「未测试」→
   点「测试 …」后变「通过」→ 走确认框「确认删除」→ 行消失；
3. **被策略引用的目标不允许直接删除**：从策略表取第一个目标名 → 删 → 断言 toast 出现
   「仍被备份策略引用」且目标行仍在（后端 409 `DESTINATION_IN_USE`，前端原样透出）；
4. **立即备份 → 完整性校验 → 隔离恢复演练**：点「立即备份」→「开始备份」→ 断言
   「备份完成」→ 作业历史第一行「成功」→「完整性校验」得到「校验通过」→
   「隔离恢复演练」得到「演练通过」，且演练表新行的环境是 `isolated-container-db`；
5. **只读角色（`05-backups.spec.ts:118`）**：用 `audit@xinglan.dev`（只有 `backup:read`）
   登录 → 页面能读到真实数据（「最近成功备份」有值、不是空白页）→
   「立即备份 / 新增目标 / 新增策略」三个按钮全部 `disabled` →
   顶部出现「当前账号对备份只有只读权限」并点名 `backup:write`。

第 5 条踩到一个 Playwright 细节：`browser.newContext()` **会继承项目 `use` 里的
`storageState`**，所以手动建 context 也还是所有者的会话，登录页直接被跳过。
正确做法是在 describe 里 `test.use({ storageState: { cookies: [], origins: [] } })`，
再用默认 `page` fixture 走真实登录。

实测每次跑都会产生一条 `succeeded` 作业和一条 `passed` 演练（RTO 2–4 秒），
测试用的目标名带时间戳后缀，重复执行不会撞唯一约束。

### 4.7 纯净种子下的两条失败（本轮实测，未修）

本轮按「先 `npm run db:seed` 再跑」的干净库重跑 `npx playwright test`，结果稳定是
**14 passed / 2 failed**（16 条里），两条都在 `tests/e2e/05-backups.spec.ts`：

```
✘ 5.3 被策略引用的目标不允许直接删除  (tests/e2e/05-backups.spec.ts:68)
   Test timeout of 45000ms exceeded.
   locator('table').nth(1).locator('tbody tr').first() 一直等不到元素

✘ 5.4 立即备份 → 完整性校验 → 隔离恢复演练  (tests/e2e/05-backups.spec.ts:92)
   expect(page.getByText(/备份完成/)).toBeVisible({ timeout: 60_000 }) 超时
```

根因（已定位，不是偶发）：`prisma/seed.ts` **不创建任何备份存储目标与备份策略**
（`grep -n 'backupStorageDestination\|backupPolicy' prisma/seed.ts` 无命中，
`select count(*) from backup_storage_destinations` = 0）。而这两条用例的前提是
「策略表里已经有一个目标」——第 3 条要从策略表取第一个目标名去删，第 4 条要先有目标才能
点「立即备份」。纯净种子下这个前提不成立，所以必然失败。

为什么以前是绿的：早先那几次是在跑过多轮 e2e 的库上执行的，前一轮用例自己创建的目标残留下来，
恰好喂饱了这一轮的假设。一旦重灌种子就复现失败。

**本轮不改**（阶段 0 只做文档与实测对账，禁止改测试或 `src/` 业务代码）。两条可选修法留待后续阶段：

1. 给 `prisma/seed.ts` 补一个本地暂存目标 + 一条引用它的策略（改动最小，但会改变「纯净种子」的语义）；
2. 让用例自己用 `request.post("/api/v1/admin/backups/destinations")` 建前置数据并 `afterAll` 清理
   （更自洽，测试不依赖种子，但要顺带处理「被策略引用」这条需要真建策略）。

---

## 5. 修掉的真实缺陷

E2E 与截图巡检逼出来的都不是测试问题，而是产品问题。

### 5.1 产品详情页整页崩溃（`licenseByStatus.map is not a function`）

- 现象：从产品列表进入任意产品详情，页面只剩 Next 的「This page couldn't load」。
- 根因：详情接口 `/api/v1/admin/products/[id]` 里
  `licenseByStatus: Object.fromEntries(licenseStats.map(...))` 返回的是
  **`{ "active": 163, "suspended": 5 }` 这样的对象**，页面却声明成
  `Array<{ status: string; count: number }>` 并直接 `.map`。类型是页面自己写的，
  TypeScript 检查不到接口真实形状，所以 `tsc` 一直是 0 错。
- 修复：类型改成 `Record<string, number>`，渲染前 `Object.entries(...)` 转换；
  同时新增 `04-routes.spec.ts` 让这条路径以后每次都被点到。
- 教训：**前端手写的接口类型不构成契约**。详情页这类低频路径必须进自动化巡检。

### 5.2 登录成功后无限跳转

- 现象：登录接口 200，但 URL 停在 `/login?next=…`，`/api/v1/auth/session` 被反复请求。
- 根因：`SessionProvider` 挂在根布局，登录前拿到的 401 被缓存成 `unauthenticated`；
  登录成功后没人刷新它 → `AppShell` 认为未登录、跳回 `/login` → 登录页「已登录」逻辑
  又跳回后台，形成闭环。
- 修复：登录页引入 `useSession()`，在 `router.replace(next)` 前 `await refreshSession()`。

### 5.3 移动端抽屉「点了没反应」

- 现象：点汉堡按钮，抽屉闪现后立即关闭。
- 根因：`onNavigate={() => setMobileOpen(false)}` 每次渲染都是新函数，`RouteBridge` 的
  `useEffect(..., [pathname, onNavigate])` 于是在每次渲染后都重跑一次，刚打开就被关掉。
- 修复：`const closeMobileNav = useCallback(() => setMobileOpen(false), []);` 固定引用。

### 5.4 一条指向不存在路由的链接（预取 404）

- 现象：授权详情页导航后 console 出现 `Failed to load resource: 404`。
- 根因：页面里客户名链接到 `/app/customers/{id}`，但该路由当时不存在；
  Next 的 Link 预取于是拿到 404 的 RSC 载荷。
- 修复：补上真实的客户档案页 `/app/customers/[id]`，用已有的
  `/api/v1/admin/customers/[id]` 渲染客户资料、该客户授权列表与身份绑定；
  客户列表也改成整行可点，与产品/授权/设备的交互保持一致。
- 教训：**预取会提前暴露失效链接**，路由巡检要把 `response` 监听也纳进来。

### 5.5 截图肉眼核查发现的 4 处呈现缺陷

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| 仪表盘柱状图缩在卡片中间，两侧各留约 100px 空白 | SVG 用固定 `viewBox`，宽卡片里被等比缩小并居中 | 弃用 SVG 改 HTML flex 柱状图，柱子 `flex-1`，网格线 `absolute` + `bottom: %` |
| Toast 挡住右上角「刷新 / 签发授权」 | `Toaster position="top-right"` | 改 `position="bottom-right"` |
| 未激活的 30 天授权显示成「永久有效」 | `expires_at` 为 NULL 一律当永久，忽略了按次起算的授权 | 三态：有到期时间 → 到期日；按次未起算 → 「激活后 30 天」；lifetime → 「永久有效」 |
| 授权详情页两枚徽章都写「已暂停」 | 有效状态与管理状态同文案并列，读不出谁是谁 | 各自加 `有效状态` / `管理状态` 前缀标签 |

以及移动端：授权列表在 390px 下「开始/到期」被裁切，按 6.1 的列收放规则隐藏
周期/兑换码/创建时间，客户列加 `max-w-[160px]` 让 `truncate` 真的生效。

### 5.6 种子数据自身不自洽（被误认为算错日期）

一条授权标注「一年（12 个自然月）」，显示的开始/到期却是 2026/07/05 → 2027/05/21，
只有 320 天，起算时间还早于签发时间。根因是 `prisma/seed.ts` 里 `expiresAt` 用
`daysLater(200)` 这样的手写常量，与该授权的套餐周期各算各的。
改为 `addDuration(startsAt, plan.duration, TIMEZONE)` 现算后，3 个自然月就是
09/18 → 12/18，可当场验算。

**演示数据的内部矛盾会被当成代码 bug**——种子数据也要守住「周期 = 到期 − 起算」这条不变式。

同一批还修了一个「不完整」问题：套餐的功能默认值只覆盖了 FluxPanel 的功能码，
另外三个产品的 20 个套餐列表里全是「功能 0」。改成按功能位次与套餐档位推导后，
`plan_features` 从 13 行变为 65 行，每个套餐都带齐自己产品的功能默认值。

### 5.7 「近 14 天」图表只画了 8 天

标题写「近 14 天授权验证量」，页面上只有 8 根柱、横轴从 10-26 开始。
两个独立原因：SQL 只 `GROUP BY` 已有行、没有补零（没请求的那天直接消失）；
种子日志 `hoursAgo(i * 0.6)` 最多 155 小时，只覆盖 6.5 天。

修法：`src/app/api/v1/admin/dashboard/route.ts` 用 `generate_series(0, 13)` 生成日期桶
`LEFT JOIN` 事实表，并 `date_trunc('day', created_at AT TIME ZONE $2)` 按**组织时区**切日
（否则 UTC 的「今天」在北京时间 8 点前会错开一整天）；种子日志铺满 336 小时。
修后 14 根柱、每天 18~19 次调用，横轴 10-20 → 11-02 连续。

同一批还修了「近 7 天新增激活」恒为 0：`activation_events.created_at` 原来写死
`daysAgo(25 - d)`（21~25 天前），改成 `daysAgo((d / 5) * 13 + Math.random() * 2)` 后
该指标显示 380 次，与 444 台活跃设备量级相符。

**「近 N 天」是承诺不是文案**：补零、按业务时区切日、种子覆盖到窗口边界，三件事缺一条图表就在骗人。

### 5.8 品牌改名（LicenseHub → 子铭）

`grep -rn "LicenseHub"` 共 7 处代码 + 3 处文档。除了页面可见的侧栏/登录页，还要改三处
容易漏掉的载体：`metadata.title`（浏览器标签）、`otpauthUri` 的 `issuer`（验证器 App 里
显示的名字）、`localStorage` key（`ziming.sidebar.collapsed`）。改完重新构建、重启、
重截全部截图——截图是交付物，品牌不一致就是交付不一致。

### 5.9 改了 `src/lib/config.ts` 之后备份一启动就崩（Turbopack 陈旧模块）

- 现象：`POST /api/v1/admin/backups/jobs` 返回 422 `BACKUP_FAILED`，消息
  `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined`。
- 定位：堆栈指到 `keyBuffer (src/lib/services/backup/crypto.ts:17)`，即
  `config.backupEncryptionKey` 是 `undefined`。但源码里该字段存在，`.next/dev` 里编译出来的
  `config` 也有这一行。
- 根因：dev server 已连续跑了几小时，**`@/lib/config` 的模块实例是旧的**——新增字段没有被
  已经加载的模块实例带上。Turbopack 的按需编译只重编改过的文件，不会让已驻留的模块实例复活。
- 修法：杀掉 3000 端口进程重启 dev server，立刻 201。
- 教训写成规矩：改 `src/lib/config.ts` 这类被全站引用的模块，**先重启再判断代码对错**。

### 5.10 一条「假通过」的集成测试（读错字段名）

- 现象：集成测试「挑战 → 激活 → 心跳轮换 → 权限 → 解绑」在
  `expect(entitlements.status).toBe(200)` 处失败，实际 401。
- 根因：心跳接口返回的是 **snake_case** 的 `access_token`，测试却读
  `heartbeat.json.data!.accessToken`（camelCase）→ `rotated` 是 `undefined`；而下一条断言
  `expect(rotated).not.toBe(token)` 对 `undefined` 同样成立，于是**测试自己把错误掩盖了**，
  直到拿 `undefined` 当令牌去请求才炸出来。
- 修法：改成 `data.access_token`，并补两条形状断言
  （`typeof rotated === "string"`、`rotated.split(".")` 长度 2），让「读到 undefined」不可能再蒙混过
  关。
- 教训：`not.toBe(...)` 这类否定断言单独用是无效防护，必须先断言「拿到了东西、且形状对」。

### 5.11 备份目标删除没有二次确认

- 现象：写 E2E 时发现「删除目标」点一下就发 `DELETE`，没有任何确认。
- 这违反设计系统里「危险操作必须确认」的约定，而且删除会连带清掉该目标的作业副本记录。
- 修法：改用 `AlertDialog` 二次确认，文案写清后果（「它历史上的作业副本记录也会一并清除
  （作业本体与审计保留）」），并提示「只想暂停请改用启用开关」。
- 顺带补了表单可访问性：目标弹窗的三个输入框此前没有 `id`，`Label` 的 `htmlFor` 指不到控件，
  屏幕阅读器和 `getByLabel` 都取不到——补 `htmlFor`/`id` 配对后 E2E 才能用标签定位。

### 5.12 只读账号看到一堆能点的按钮（点了才 403）

- 现象：用 `audit@xinglan.dev`（只有 `backup:read`）打开备份页，数据都在，
  但「立即备份 / 新增目标 / 新增策略」和行内的「测试 / 编辑 / 删除」看起来都能点。
- 排查：先怀疑 `hasPermission` 没生效，实测按钮确实带了 `disabled` 属性——
  是我第一轮核查时只读了 `innerText`，没查 `isDisabled()`，误判了。
  真正的缺陷是**禁用之后没有任何解释**：用户看到一个不能点的按钮，不知道是权限不够、
  还是系统坏了、还是要先做别的操作。
- 修法：`!canWrite` 时在页面顶部插一条 `Lock` 图标的 `Alert`，明写
  「当前账号对备份只有只读权限…需要请联系管理员为你的角色开通 backup:write 与 backup:restore」，
  并把这条规则写进设计系统（5.4.1 无权限的操作：禁用 + 说明）。
- 加了 E2E 第 5 条守住这个行为，顺带发现 `browser.newContext()` 会继承项目 `storageState`
  这个坑（详见 4.6）。

---

### 5.13 示例在自定义 `LICENSE_KEY_DIR` 下直接崩（Python / PHP / Go）

症状：

```
FileNotFoundError: [Errno 2] No such file or directory: '/tmp/python-keys/ziming-example-device.key'
PHP Warning:  file_put_contents(/tmp/php-keys/ziming-example-device.sodium): Failed to open stream
设备密钥读写失败： open /tmp/go-keys/ziming-example-device.key: no such file or directory
```

原因：三个示例都假定 `LICENSE_KEY_DIR` 已存在。默认值是系统临时目录（当然存在），
所以「用默认值跑一遍」永远发现不了；一旦按 README 传了自定义目录就崩。
PHP 那一版更阴——`file_put_contents` 只抛 Warning 不返回失败（旧代码没检查返回值），
于是「写失败」被当成「写成功」，后面拿空字符串去签名。

修法：Python `os.makedirs(..., mode=0o700, exist_ok=True)`、PHP `mkdir(0700, true)` +
检查 `file_put_contents` 返回值 + `chmod 0600`、Go `os.MkdirAll(dir, 0o700)`。
Java（`Files.createDirectories`）与 C#（`Directory.CreateDirectory`）本来就建目录，所以没暴露。

## 6. 规格 15.10 · UI 设计验收（逐条）

| # | 检查项 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 路由可直接访问、刷新正常 | ✅ | E2E 逐项导航；折叠状态刷新后保持 |
| 2 | 导航 Active State 与路由一致 | ✅ | `matchPrefixes` 让 `/app/licenses/<id>` 仍高亮「授权管理」；E2E 断言 URL+h1 |
| 3 | 按钮 7 状态正确 | ✅ | `Button` 变体 + `focus-visible`/`hover`/`active`/`disabled`；提交中显示 Spinner 并禁用 |
| 4 | 分页/筛选/排序确实用后端数据 | ✅ | 参数进 URL，服务端 `LIMIT/OFFSET/ORDER BY`；`status` 筛选走 SQL 计算状态 CASE |
| 5 | 表单校验、错误提示、防重复提交 | ✅ | 前端即时校验 + 服务端 `fieldErrors` 回填；提交中按钮 `disabled` |
| 6 | Dialog/Drawer 打开关闭/焦点/确认 | ✅ | Radix 提供焦点陷阱与 Esc；`DrawerTitle` 提供可访问名称；E2E 验证 Esc 关闭 |
| 7 | 危险操作有确认、服务端有权限与审计 | ✅ | 全部走 `ConfirmDialog`；服务端 `withAdmin(permission)` + `writeAudit` |
| 8 | Loading/Empty/Error/Success 四态 | ✅ | `DataTable` 四态分支 + `ErrorState` 带 code/requestId + `toast.success` |
| 9 | 桌面/平板/窄屏无溢出遮挡 | ✅ | 三档断点；E2E mobile project 验证抽屉与列表控件 |
| 10 | 键盘操作、焦点可见、对比度 | ✅ | `:focus-visible` 2px 环；`--warning-foreground` 用深色保证 4.5:1；图标按钮均有 `aria-label` |
| 11 | 无无效链接、无空按钮、无假交互 | ✅ | 16 个导航项全部有页面；E2E 断言无 404；所有按钮都发真实请求 |
| 12 | 不用静态假数据冒充 API | ✅ | 全部页面数据来自 `useResource` 拉真实接口；`/app/developer/api` 的「连通性自检」也是真实 `fetch` |

**第 11 条的补充说明**：项目里没有「点了只变色」的控件。所有切换类控件（Switch、
周期预设按钮）都会发请求或改变受控表单状态；折叠侧栏改变的是持久化布局状态。

---

## 7. 规格 15.11 · 交付清单

| 交付项 | 产物 |
| --- | --- |
| UI 页面地图与导航结构 | [`README.md`](../README.md#3-页面地图) 第 3 节；`NAV_GROUPS`（`src/lib/domain/permissions.ts`） |
| 全局设计 Token | [`design-system.md`](./design-system.md) 第 1–4 节；`src/app/globals.css` |
| 统一组件 | [`design-system.md`](./design-system.md) 第 5 节；`src/components/app/`（16 个）+ `src/components/ui/`（29 个 shadcn） |
| 每页四态 | `DataTable` / `ErrorState` / `EmptyState` / `TableSkeleton` / `DetailSkeleton`，各页已接入 |
| 页面与 API 对接清单 | [`api.md`](./api.md) 第 5 节 |
| 可运行预览 | `npm run dev` → http://localhost:3000（种子账号见 README） |
| 交互验收清单与测试结果 | 本文件第 6 节（15.10 逐条）+ 第 1–4 节（测试结果） |
| VibeHub 安装/使用记录 | [`vibehub-terminology.md`](./vibehub-terminology.md) 第 1、4 节 |

**截图**：共 31 张，已随仓库提供（[`docs/shots/`](shots/README.md)），全部基于虚构种子数据截取——v1.5.0 公开发布前曾因早期截图含真实客户名称而整目录移除，现用虚构数据重建后恢复：

| 分组 | 文件 |
| --- | --- |
| 概览与授权 | `dashboard.png`、`licenses.png`、`license-detail.png` |
| 业务配置 | `products.png`、`product-detail.png`、`customers.png`、`customer-detail.png`、`plans.png`、`features.png`、`devices.png` |
| 开发者中心 | `developer-api.png`、`developer-credentials.png`、`developer-webhooks.png` |
| 安全与系统 | `signing-keys.png`、`verification-logs.png`、`audit-logs.png`、`settings-members.png`、`settings-organization.png`、`settings-system.png`、`settings-profile.png` |
| 备份与灾备（v1.5） | `backups.png`（整页）、`backups-top.png`（首屏）、`backups-readonly.png`（只读账号视角：写操作按钮全部禁用） |
| 移动端（390×844） | `mobile-dashboard.png`、`mobile-licenses.png`、`mobile-backups.png` |

重新生成：见 [`docs/shots/README.md`](shots/README.md) 的三步说明（隔离库 + 虚构 seed + Playwright）。

---

## 8. 未覆盖与已知限制

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 设备详情页 `/app/devices/[id]` | 未实现页面 | 后端 `GET /admin/devices/[id]` 已就绪（设备档案 + 激活历史 + 事件），设备列表可查可筛选、行内可直接释放/封禁；独立详情页未做，不在 NAV 中 |
| 角色管理页 `/app/settings/roles` | 未实现页面 | 后端 `GET/POST /admin/roles` 已就绪，成员页的角色下拉已消费该接口 |
| 多实例部署 | 未验证 | 登录限流与幂等是进程内实现，多实例需换 Redis（代码注释已标注） |
| 真实 Webhook 外发 | 未验证 | 端点/投递/重投全链路已实现，但本轮没有真实外部接收端做端到端签名校验 |
| 离线宽限期 | 未验证 | 数据模型与套餐字段就绪，客户端离线校验逻辑不在本仓库 |
| 浏览器兼容 | 部分 | 只在 Chromium 验证；未跑 Firefox/WebKit |
| S3 / WebDAV / SFTP 真实对象存储 | 未验证 | 四种适配器都有完整实现（SigV4 手写签名、逐级 MKCOL、hostKey 指纹比对），但本轮只在本地暂存目标上跑通了端到端；远端目标只能证明「逻辑正确」，不能证明「对端可用」，因此 `capabilities()` 一律返回 false，页面也不把未测协议标成已支持 |
| 生产库恢复 | 未实现（有意） | 只提供隔离恢复演练（建临时库 → 灌数据 → 对账 → 删库）。生产回滚需要 Owner 双人确认 + 确认短语 + 不可删除审计，属于 P1 |
| WAL 连续归档 / PITR | 未实现 | 当前是逻辑备份（`pg_dump` 自定义格式）。页面在「目标健康」里明写「WAL 归档：未启用」，不暗示具备时间点恢复能力 |
| 定时调度执行器 | 未接入 | 策略存了 cron（`0 3 * * *`）并做了格式校验，但本轮没有常驻调度进程按时触发；手动「立即备份」是真实可用的 |
