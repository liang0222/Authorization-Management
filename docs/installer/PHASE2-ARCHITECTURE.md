# Phase 2 · 架构设计

> 前置阅读：[PHASE1-AUDIT.md](./PHASE1-AUDIT.md)
> 本文回答三个问题：**分成哪几层**、**状态怎么判**、**失败怎么恢复**。
> 所有设计都能在代码里找到对应文件，不是纸面方案。

---

## 1. 四层结构

```
┌──────────────────────────────────────────────────────────┐
│ Layer 3  UI          src/app/install/ + src/components/install/ │
│          向导、环境展示、表单校验、实时进度、失败提示        │
├──────────────────────────────────────────────────────────┤
│ Layer 2  Adapter     src/lib/installer/adapters/<project>/  │
│          detect / manifest / validate / test / inspect /     │
│          migrate / initialize / createAdmin / healthCheck    │
├──────────────────────────────────────────────────────────┤
│ Layer 1  Core        src/lib/installer/*.ts                 │
│          contract manifest state store lock env-probe        │
│          database migrations config-writer orchestrator      │
│          guard runtime                                       │
├──────────────────────────────────────────────────────────┤
│ Layer 4  Runtime     systemd + openresty + 数据目录           │
└──────────────────────────────────────────────────────────┘
```

**解耦规则（验收标准 J）**：Layer 1 的 12 个文件**不 import 任何** `@/lib/services/*`、`@/lib/domain/permissions`、`@/lib/auth/*`、`@/lib/db`。
唯一例外是 `runtime.ts`——它属于"接线层"，负责把本项目的 Adapter 塞给 Core。

```bash
# 可复现验证
grep -l "@/lib/\(services\|auth\|db\|domain\)" src/lib/installer/*.ts
# 只有 runtime.ts
```

---

## 2. Installer Contract

`src/lib/installer/contract.ts` 定义 9 个生命周期方法：

| 方法 | 职责 | 允许失败吗 |
| --- | --- | --- |
| `detect()` | 确认"这个目录是不是目标项目" | 否 |
| `getManifest()` | 返回 `ProjectManifest` | 否 |
| `validateConfig(input)` | 字段级 + 跨字段校验 | 返回 issues，不抛 |
| `testDatabase(input)` | 连接测试，返回延迟与版本 | 返回 `ok:false`，不抛 |
| `inspectDatabase(input)` | 只读预检：表数 / 迁移数 / 业务数据 / 权限 | 返回 warnings，不抛 |
| `runMigrations(ctx)` | 执行迁移（含迁移前备份） | 返回 `ok:false` |
| `initialize(ctx)` | 幂等初始化（权限、组织、角色、签名密钥） | 返回 `ok:false` |
| `createAdmin(ctx)` | 建管理员（已存在则沿用） | 返回 `ok:false` |
| `healthCheck(ctx)` | 安装后自检 | 返回 `ok:false` |
| `recordInstall?(ctx, record)` | 写数据库安装记录（可选） | 失败只告警 |

**约定**：除了 `detect()` / `getManifest()`，其余方法都**不抛异常**，而是返回带 `ok` 的结构。
原因：编排器要逐步记录状态，抛异常会丢失"哪一步失败"的上下文。

---

## 3. Manifest 规范

`src/lib/installer/manifest.ts` 用 zod 校验，`ProjectManifest` 的必填项：

```ts
{
  manifestVersion: "1.0",
  project: { id, name, version, description?, accentColor?, logoText? },
  adapter: string,                    // 适配器标识
  requiresInstaller: ">=1.0.0 <2.0.0",// 版本兼容区间
  database: { type, minVersion?, urlTemplate? },
  fields: { admin: [...], database: [...], system: [...] },
  migration: { engine, path, backupBeforeMigrate? },
  i18n: { default, supported },
  writablePaths: string[],
  successRedirect: string,            // 站内绝对路径
}
```

三条硬校验：

1. **`project.id` 必须匹配 `^[a-z0-9][a-z0-9-]*$`** —— 它会拼进文件路径（`/var/lib/universal-installer/<id>/`），不校验就是路径穿越。
2. **`successRedirect` 必须是站内绝对路径**，且 `.refine(v => !v.startsWith("//"))` —— 否则是开放重定向。
3. **`secret: true` 的字段不许有 `default`**，且全文扫描 `ghp_` / `AKIA` / `sk-` / `xox[baprs]-` / `BEGIN ... PRIVATE KEY` —— 防止把密钥写进 Manifest。

版本兼容用 `satisfiesRange()`：只支持空格分隔的 AND 约束（`>=1.0.0 <2.0.0`），**故意不支持** `||` / `~` / `^`，因为安装器不需要那么复杂的语义，支持越多越容易判错。

---

## 4. 状态机

`src/lib/installer/state.ts`：

```
UNINSTALLED ──▶ INSTALLING ──▶ INSTALLED ──▶ MAINTENANCE
                    │              ▲              │
                    ├──▶ FAILED ───┘              │
                    │       │                     │
                    └──▶ RECOVERY ◀───────────────┘
UNKNOWN ──▶ UNINSTALLED | INSTALLED
```

转移表（`TRANSITIONS`）：

| from | to |
| --- | --- |
| `UNINSTALLED` | `INSTALLING` |
| `INSTALLING` | `INSTALLED`, `FAILED`, `RECOVERY` |
| `INSTALLED` | `MAINTENANCE`, `INSTALLED`（自转移幂等） |
| `MAINTENANCE` | `INSTALLED` |
| `FAILED` | `RECOVERY` |
| `RECOVERY` | `INSTALLING`, `INSTALLED`, `FAILED` |
| `UNKNOWN` | `UNINSTALLED`, `INSTALLED`, `UNKNOWN` |

两个关键判定：

- `canRunInstall(state)` → `UNINSTALLED | FAILED | RECOVERY | INSTALLING`
- `isInstallLocked(state)` → `INSTALLED | MAINTENANCE | UNKNOWN`

**`FAILED` 不能直接进 `INSTALLING`**（必须经 `RECOVERY`）。这条在实测里真的踩到过：失败后点"继续"报 `非法状态转移：FAILED → INSTALLING`，修法是编排器先落 `RECOVERY` 再进 `INSTALLING`，让路径与状态表一致，而不是绕过状态机。

---

## 5. 状态判定：五级优先

`buildSnapshot()`（`store.ts`）按顺序判定，**先命中先返回**：

| 优先级 | 信号 | 结果 | 说明 |
| --- | --- | --- | --- |
| 0 | 本地状态 ∈ {INSTALLING, FAILED, RECOVERY} | 原样返回 | **在途安装优先**，见 §6 |
| 1 | `installed.lock` 存在且校验和正确 | `INSTALLED` / `source=lock` | 最快路径，纯文件读 |
| 1' | 锁存在但校验和不符 | `INSTALLED` / `tampered=true` | 文件被改过 |
| 2 | 库里有 `installer_records` 行 | `INSTALLED` / `source=database` / `tampered=true` | **锁被删了**，重建锁并锁死 |
| 3 | `probe === null`（库连不上） | `UNKNOWN` | **绝不判成未安装** |
| 4 | `probe.installed`（有表 + 有组织数据） | `INSTALLED` / `source=adopted` | 自适配既有实例，写 `adopted:true` 的锁 |
| 5 | 本地 `state.json` 或默认 | `UNINSTALLED` | |

**为什么优先级 0 必须在最前面**：第一次安装跑到 `initialize` 失败时，库里已经有 42 张表和 1 个组织。
如果按优先级 4 走，状态会变成 `INSTALLED` 并被锁死，用户永远无法"继续安装"——而规格明确要求支持安装失败恢复。

**为什么优先级 3 不能是 `UNINSTALLED`**：数据库暂时连不上（网络抖动、容器重启中）如果判成未安装，用户点安装就会覆盖真实数据。规格原文：「DB 暂时连不上时不能误判为未安装」。

---

## 6. 安装锁与互斥

`src/lib/installer/lock.ts`：

- 文件 `install.lock`，内容 `{token, pid, host, acquiredAt, heartbeatAt}`，`openSync(path, 'wx', 0o600)` 原子创建
- 运行期每步 `held.heartbeat()` 刷新 `heartbeatAt`
- 陈旧判定 `isStale()`：`heartbeatAt` 超过 90s，**或**同机 pid 已不存在（`EPERM` 算活着）
- 接管：把陈旧锁 `rename` 成 `install.lock.stale-<ts>` 后重试一次
- 释放：只删自己 token 的那把锁

实测：两人同时点安装，第二个得到 `INSTALL_BUSY`（`另一个安装进程正在运行（pid 579693，心跳 …）`）。

**另有 `installed.lock`**（注意不是 `install.lock`）：这是"已安装"的凭据，含 `checksum`（对内容做 SHA-256）。两者不要混淆。

---

## 7. 数据目录布局

```
$INSTALLER_DATA_DIR/<project-id>/          # 默认 /var/lib/universal-installer
├── installed.lock       0600  已安装凭据（含 checksum）
├── install.lock         0600  运行期互斥锁（结束后删除）
├── state.json           0600  当前状态 + 原因 + 最近 attempt
├── csrf.key             0600  安装期 CSRF 签名密钥（32B base64url）
├── install.log          0600  逐行 JSON 日志
└── attempts/
    └── <attempt-id>.json 0600 每次安装尝试的完整步骤记录
```

所有写入走 `atomicWrite()`：同目录临时文件 → `fsync` → `rename`。
`projectDataDir(projectId)` 做**双重校验**（正则 + `resolve` 后确认仍在根目录内），防路径穿越。

日志脱敏 `redact()` 覆盖 5 类：`postgres://user:pass@…`、`"password": "…"`、`password=…`、`scrypt$…`、`-----BEGIN … PRIVATE KEY-----`。

---

## 8. 安装流程（14 步）

`orchestrator.ts` 的 `runInstall()`：

| # | phase | 做什么 | 失败后果 |
| --- | --- | --- | --- |
| 1 | `identity` | `adapter.detect()` 确认目录是目标项目 | 中止 |
| 2 | `installer-version` | 校验 `requiresInstaller` 区间 | 中止 |
| 3 | `install-state` | 状态闸门 + 抢互斥锁 | 中止（`INSTALL_LOCKED` / `INSTALL_BUSY`） |
| 4 | `environment` | 环境检测（磁盘、权限、端口、docker…） | 有 fail 则中止 |
| 5 | `validate` | 表单校验（含两次密码一致） | 中止 |
| 6 | `database` | 连接测试 | 中止 |
| 7 | `db-precondition` | 只读预检（表数、权限、业务数据） | 缺权限则中止 |
| 8 | `migrate` | 迁移前备份 + `prisma migrate deploy` | 中止 |
| 9 | `initialize` | 权限/组织/角色/签名密钥（幂等） | 中止 |
| 10 | `admin` | 建管理员（已存在则沿用） | 中止 |
| 11 | `config` | 写运行配置（保留已有键） | 中止 |
| 12 | `finalize` | 写 `installed.lock` + 转 `INSTALLED` + 写库记录 | 中止 |
| 13 | `healthcheck` | 安装后自检 | 中止 |
| 14 | `lockdown` | 复核入口已关闭 | 中止 |

每一步都落 `running` → `ok`/`failed` 到 `attempts/<id>.json`，并刷新心跳。

---

## 9. 失败恢复

失败时：

1. `attempt.status = "failed"`，记 `error.phase` / `error.message`
2. `state` 转 `FAILED`（含原因）
3. 写日志

恢复时（`resume: true`）：

1. 状态闸门允许 `FAILED` / `RECOVERY` / `INSTALLING` 进入
2. 先 `FAILED → RECOVERY`，再 `RECOVERY → INSTALLING`
3. **管理员邮箱不能换**：`attempt.adminEmail` 与提交值不一致则拒绝（`上次安装已创建管理员 X，恢复时不允许更换为 Y`）
4. 每一步都幂等：迁移靠 `_prisma_migrations`；权限靠"按缺失补齐"；组织靠 `findFirst`；角色靠 upsert；管理员靠 email 查重；签名密钥靠"已有 active 就跳过"

---

## 10. 安全设计（对应规格 16 条）

| 规格要求 | 实现 |
| --- | --- |
| 敏感数据不进 Git | `.gitignore` 已含 `.keys*` / `.backups*` / `.env` |
| 配置不下发浏览器 | 运行配置只写服务端文件；API 响应不含 `database.password` |
| 密钥不明文公开目录 | `csrf.key` / `installed.lock` / `state.json` 全 0600，目录 0700 |
| 临时文件 + 原子替换 | `atomicWrite()`：tmp → fsync → rename |
| 互斥锁 | `install.lock` + `wx` 创建 + 心跳 + 陈旧接管 |
| CSRF 保护 | `x-install-csrf` HMAC 令牌（TTL 1h）+ HttpOnly Cookie |
| 同源保护 | `guardInstallPost()` 校验 `Origin` 与 `Host` 一致 |
| 防暴力调用 | 滑动窗口限流：run 40/min、state 120/min、log 60/min |
| 防路径穿越 | `project.id` 正则 + `resolve` 双重校验 |
| 日志不记明文密码 | `redact()` 5 类模式 |
| 状态不能只依赖 Cookie | 状态来自文件 + 数据库，Cookie 只存 CSRF |
| 安装完成后禁止初始化 | `isInstallLocked()` 让 4 个 API 全部返回 409 |
| 不允许删锁重装 | 锁删了但库里有 `installer_records` → `source=database` + `tampered=true`，仍锁死 |
| 不允许覆盖现有管理员 | `createAdmin()` 先查 email，存在则 `alreadyExisted: true` 且**不改密码** |
| DB 有业务数据不清空 | `inspectDatabase()` 只读；`db-precondition` 只警告不删 |
| DB 连不上不误判 | `probe === null` → `UNKNOWN` → 锁定 |

---

## 11. 根路径门禁：为什么用 Proxy 而不是 redirect()

第一版在 `src/app/page.tsx` 里用 `redirect()`，实测**返回 200 而不是 307**，HTML 是 `<html id="__next_error__">` + `digest":"NEXT_REDIRECT;replace;/app/dashboard;307;"`。

根因：本项目开了 `cacheComponents`，`await connection()` 之后响应头已经发出，`redirect()` 只能退化成客户端 meta 跳转——没有 JS 的客户端会停在空壳页。

Next 官方文档 `redirect.md` 原文：「When used in a streaming context, this will insert a meta tag to emit the redirect on the client side」+「If you'd like to redirect before the render process, use next.config.js or Proxy」。

最终方案 `src/proxy.ts`：只做纯 `fs.existsSync()` 检查，不连数据库。

```ts
export function proxy(request: NextRequest) {
  const lockPath = join(DATA_ROOT, PROJECT_ID, "installed.lock");
  const url = request.nextUrl.clone();
  url.pathname = existsSync(lockPath) ? "/app/dashboard" : "/install";
  url.search = "";
  return NextResponse.redirect(url);
}
export const config = { matcher: "/" };
```

**注意**：Next 16 里 `middleware` 已废弃改名 `proxy`，文件是 `src/proxy.ts`，导出 `proxy()` 或 default。

---

## 12. 对现有实例的兼容（验收标准 K）

现网 3100 的库里有 41 张表 + 组织数据，但**没有** `installed.lock`。
上线后第一次访问 `/` 时：

1. Proxy 看锁不存在 → 跳 `/install`
2. `/install` 做五级判定 → 命中优先级 4（`probe.installed`）→ 判 `INSTALLED` / `source=adopted`
3. 自动写 `adopted:true` 的锁
4. 之后再访问 `/` → Proxy 看到锁 → 307 → `/app/dashboard`

实测结果：`state=INSTALLED source=adopted adopted=true`，理由 `检测到项目已有数据（41 张表；organizations 有数据），按已安装处理并自动写入安装锁`。
生产 `/` 仍是 307 → `/app/dashboard`，journal error 0。

**自适配只写锁文件，不对生产库执行任何 DDL。**

---

## 13. 接入新项目的步骤

1. 在 `src/lib/installer/adapters/<your-project>/manifest.ts` 写 `ProjectManifest`
2. 在同目录 `index.ts` 实现 `InstallerAdapter` 的 9 个方法
3. 在 `src/lib/installer/runtime.ts` 把 `adapter()` 换成你的实例
4. UI 不用改：`wizard.tsx` 完全由 Manifest 驱动（字段、分组、校验规则、颜色、跳转）

详见 [INTEGRATION.md](./INTEGRATION.md)。

---

## 14. 已知取舍

| 取舍 | 理由 |
| --- | --- |
| 不做独立微服务，内嵌 Next route | 少一个进程、少一套部署；Core 仍是纯 TS，理论上可抽出 |
| 不自己写迁移引擎 | 规格要求"优先适配项目原有迁移系统"；Prisma 的 `_prisma_migrations` 已是事实标准 |
| 限流是进程内 Map | 单实例够用；多实例需换 Redis（已记为已知限制） |
| `satisfiesRange` 只支持 AND | 版本区间越复杂越容易判错，安装器不需要 `\|\|` |
| 自适配不写库 | 避免在页面请求里对生产库执行 DDL |
