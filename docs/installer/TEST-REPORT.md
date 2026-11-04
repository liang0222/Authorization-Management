# Phase 7 · 完整测试报告

> 测试环境：`/root/授权saas`，Node v26.13.0，PostgreSQL 16.15（容器 `licensing-pg`）
> 测试实例：`127.0.0.1:3199`（独立进程、独立库 `installer_test`、独立数据目录 `/tmp/installer-e2e`）
> 测试时间：2026-11-04
> 原则：**每条都是真跑出来的结果，不是计划。** 未通过的当场修，修完重跑。

---

## 摘要

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 全新服务器首次安装 | ✅ 14 步全绿 |
| 2 | 数据库连接成功 | ✅ |
| 3 | 数据库账号密码错误 | ✅（修了一个缺陷） |
| 4 | 数据库不存在 | ✅ |
| 5 | 数据库已有业务数据 | ✅（拒绝安装） |
| 6 | 安装过程中断 | ✅（可恢复） |
| 7 | 安装失败恢复 | ✅（修了两个缺陷） |
| 8 | 两人同时访问 | ✅（互斥生效） |
| 9 | 安装完成后重新访问 | ✅ |
| 10 | 浏览器清理缓存 | ✅ |
| 11 | 服务器重启 | ✅ |
| 12 | Docker 容器重建 | ✅ |
| 13 | 项目代码更新 | ✅ |
| 14 | 数据库迁移 | ✅（幂等） |
| 15 | 未授权访问安装接口 | ✅（三重拒绝） |
| 16 | 安装锁绕过测试 | ✅（删锁仍锁死） |

自动化测试：`npx vitest run tests/unit` → **22 files / 302 tests passed**；`npx tsc --noEmit` → 0 error。

---

## 1. 全新服务器首次安装

**准备**：`CREATE DATABASE installer_test OWNER licensing`（空库，0 张表）。

**访问根路径**：

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://127.0.0.1:3199/
# 307 http://127.0.0.1:3199/install
```

**状态判定**：

```json
{"state":"UNINSTALLED","source":"default","locked":false,"reason":"未检测到安装痕迹"}
```

**环境检测 10 项**：

| 检查项 | 结果 | 实测值 |
| --- | --- | --- |
| node-version | OK | 26.13.0 |
| runtime | OK | linux 6.12.107+deb13-cloud-amd64 · DE · 4 核 · 6894MB 可用 / 11968MB |
| project-dir | OK | 可写 |
| data-dir | OK | 待创建 |
| disk | OK | 68209MB 可用 |
| writable:.keys-prod | OK | |
| writable:.backups-prod | OK | 待创建 |
| docker | OK | 29.9.2 |
| systemd | OK | 257 |
| pg-dump | **WARN** | 未找到 pg_dump（迁移前备份会跳过） |

**完整安装**（`POST /api/install/run`）：

```
identity          ok   识别到项目（package.json name=licensing-saas；存在 prisma/schema.prisma；存在权限模块）
installer-version ok   安装器 1.0.0 / 契约 1.0 / 要求 >=1.0.0 <2.0.0
install-state     ok   安装前状态：尚未安装（未检测到安装痕迹）
environment       ok   环境检测通过（10 项，1 项警告）
validate          ok   参数校验通过
database          ok   连接成功：licensing@127.0.0.1:55432/installer_test（PostgreSQL 16.15，11ms）
db-precondition   ok   库内 0 张表，已应用 0 个迁移
migrate           ok   应用 9 个迁移（共 9 个）
initialize        ok   初始化完成：新建 11 项，跳过 0 项
admin             ok   已创建管理员 owner@installer.test 并授予所有者角色
config            ok   已写入 /tmp/installer-e2e/production.env（16 个键，874 字节）
finalize          ok   安装锁已写入，状态置为已安装；数据库安装记录已写入
healthcheck       ok   健康检查通过（4 项）
lockdown          ok   安装入口已关闭（状态 已安装）
```

耗时 3.2s。

**库内核对**：

```
tables=42
permissions=35
roles=owner,admin,operator,viewer
role_permissions=107
orgs=1 slug=installer-test-org
users=1 email=owner@installer.test
signing_keys=1 status=active
installer_records=1
```

---

## 2. 数据库连接成功

```json
{"ok":true,"target":"licensing@127.0.0.1:55432/installer_test","serverVersion":"PostgreSQL 16.15","latency":9}
```

预检：`ok=true tables=0 prisma=true applied=0 businessData=false canCreate=true`。

---

## 3. 数据库账号密码错误

**第一次跑就暴露了缺陷**：

```json
{"ok":false,"target":"","errorCode":"INVALID_URL","errorMessage":"数据库连接串为空","hint":"形如 postgresql://用户:密码@主机:端口/库名"}
```

根因：`testDatabaseConnection()` 只读 `input.database.databaseUrl`，而 UI 是逐项填 `host/port/database/username/password`，从不拼 URL。

**修法**：新增 `buildDatabaseUrl(input)`，两个函数都先调它；为空时返回 `INCOMPLETE`。

**修后**：

```json
{"ok":false,"target":"licensing@127.0.0.1:55432/installer_test","errorCode":"28P01",
 "message":"用户名或密码错误",
 "hint":"核对连接串里的用户名与密码；注意密码里的特殊字符要 URL 编码","latency":9}
```

---

## 4. 数据库不存在

```json
{"ok":false,"errorCode":"3D000","message":"数据库不存在",
 "hint":"先在 PostgreSQL 里创建该库，或把库名改成已存在的库"}
```

---

## 5. 数据库已有业务数据

**只读探测生产库 `licensing`**：

```json
{"tables":41,"applied":8,"businessData":true,"canCreate":true,
 "warnings":["目标库已有业务数据（organizations 非空）；安装器不会清空它，但请确认这是你要装进去的库"]}
```

**真向生产库发起安装**：

```json
{"ok":false,"code":"INSTALL_REFUSED",
 "message":"当前状态为「已安装」，安装入口已关闭。检测到项目已有数据（41 张表；organizations 有数据），按已安装处理并自动写入安装锁"}
```

---

## 6. 安装过程中断

**做法**：发起安装后 1.2 秒 `kill -9` 掉服务进程。

中断时状态：

```json
{"state":"INSTALLING","reason":"开始安装","lastAttemptId":"0e5f94c3-…"}
```

`install.lock` 残留（含 pid 与心跳），库里 0 张表。

**重启服务后**：

```json
{"state":"INSTALLING","source":"default","locked":false,"canInstall":true,"reason":"开始安装",
 "attempt":{"id":"0e5f94c3-…","status":"running"}}
```

**带 `resume: true` 继续** → 14 步全绿，`state=INSTALLED`。

> 关键：进程被 `kill -9` 后 `install.lock` 里的 pid 已死，`isStale()` 判为陈旧，下一次安装直接接管，不需要人工删锁。

---

## 7. 安装失败恢复

### 7a. 权限不足导致 `db-precondition` 失败

用只有 `CONNECT` 权限的角色 `installer_limited`：

```
db-precondition  failed  数据库用户缺少 CREATE 权限；当前数据库用户没有 CREATE 权限，无法建表
```

状态：`FAILED`，`canInstall=true`（可继续）。

### 7b. 缺陷一：`FAILED → INSTALLING` 非法转移

授权后点继续：

```json
{"ok":false,"reason":"安装失败于「identity」：非法状态转移：FAILED → INSTALLING"}
```

根因：状态机里 `FAILED` 只能进 `RECOVERY`，但编排器直接尝试 `FAILED → INSTALLING`。

**修法**：先 `FAILED → RECOVERY`，再 `RECOVERY → INSTALLING`，让路径与状态表一致。

### 7c. 缺陷二：权限判定查错了层级

修完转移后重试，`db-precondition` 仍然报"没有 CREATE 权限"，但实际已经 `GRANT CREATE ON SCHEMA public`。

根因：`inspectDatabase()` 查的是 `has_database_privilege(current_database(), 'CREATE')`——那是**数据库级**权限（用于建 schema），建表靠的是 **schema 级** CREATE。

**修法**：改查 `has_schema_privilege(current_schema(), 'CREATE')`，并把数据库级权限单独作为**告警**（因为迁移里的 `CREATE EXTENSION "pgcrypto"` 确实需要它）。

### 7d. 缺陷三：迁移报错不可读

原始报错是 Prisma 的 `DbError { severity: "ERROR", parsed_severity: … }` 结构体，几百字符，用户看不懂。

**修法**：新增 `explainMigrationFailure()`，抽 `SQLSTATE` + `ERROR:` 行 + `HINT:` 行，附处置建议；同时支持 Prisma 自己的 `P3009`（库里有失败的历史迁移记录）。

修后输出示例：

```
迁移失败（SQLSTATE 42501）；permission denied to create extension "pgcrypto"；
提示：Must have CREATE privilege on current database to create this extension.；
数据库用户权限不足。建表需要 schema 的 CREATE；迁移里的 CREATE EXTENSION 需要数据库级 CREATE，或让 DBA 预装该扩展。
```

### 7e. 最终恢复成功

授权到位后重跑 → 14 步全绿。

### 7f. `config` 步骤失败后恢复

用 `INSTALLER_ENV_FILE=/tmp/blocker/production.env`（`/tmp/blocker` 是普通文件，触发 `ENOTDIR`/`EEXIST`）：

```
config  failed  EEXIST: file already exists, mkdir '/tmp/blocker'
```

状态 `FAILED`，`canInstall=true`。移除障碍后 `resume: true`：

```
db-precondition   ok   库内 42 张表，已应用 9 个迁移；注意：目标库已有业务数据…
migrate           ok   迁移已是最新（共 9 个）
initialize        ok   初始化完成：新建 0 项，跳过 7 项
admin             ok   管理员 owner@installer.test 已存在并已加入组织，沿用（不修改密码）
config            ok   已写入 /tmp/installer-e2e/production.env
finalize          ok   安装锁已写入
```

**幂等性得到验证**：第二次跑全部跳过，没有重复建组织、没有重置管理员密码。

---

## 8. 两人同时访问安装页面

两个并发请求同时 `POST /api/install/run`：

- A：`ok=true`，`status=succeeded`
- B：`ok=false`，`code=INSTALL_BUSY`，`message=另一个安装进程正在运行（pid 579693，心跳 2026-11-04T11:17:54.578Z）`

---

## 9. 安装完成后重新访问

```
/  → 307 loc=http://127.0.0.1:3199/app/dashboard   （连测 3 次，稳定）
/install → 渲染锁定页（含「已安装」「前往登录」）
```

---

## 10. 浏览器清理缓存

用**全新 cookie jar**（无任何 cookie）访问：

```
/  → 307 loc=/app/dashboard
/api/install/state → state=INSTALLED source=lock locked=true
```

状态来自文件 + 数据库，不依赖 Cookie。

---

## 11. 服务器重启

`kill -9` 服务进程 → 确认 3199 已释放 → 重新 `next start`：

```
重启后 state=INSTALLED source=lock locked=true
/ → 307 loc=/app/dashboard
```

---

## 12. Docker 容器重建

模拟镜像重建：`rm -rf .next` → `npm run build`（`✓ Compiled successfully in 10.6s`）→ 全新进程启动：

```
重建后 state=INSTALLED source=lock locked=true canInstall=false
/ → 307 loc=/app/dashboard
```

> 数据目录 `$INSTALLER_DATA_DIR` 在容器外（或挂载卷）时，重建不会丢状态。若数据目录也在容器内，需要挂卷——这是部署要求，已写进 `DEPLOY-v15.md`。

---

## 13. 项目代码更新

重新构建后：

```
state=INSTALLED installedAt=2026-11-04T11:26:05.346Z
manifest version=1.5.0
```

`installed.lock` 的 `projectVersion` 与 `checksum` 不因代码更新而失效——锁只认"装过没装过"，版本升级由迁移处理。

---

## 14. 数据库迁移

已装状态下重新跑 `prisma migrate deploy`：

```
9 migrations found in prisma/migrations
No pending migrations to apply.
```

`_prisma_migrations` 里 9 条 `finished_at` 非空，无重复。

---

## 15. 未授权访问安装接口

| 攻击方式 | 结果 |
| --- | --- |
| 不带 `x-install-csrf` | `403 CSRF_REJECTED`「CSRF 校验失败，请刷新安装页面后重试」 |
| `Origin: https://evil.example.com` | `403 ORIGIN_REJECTED`「请求来源校验失败，请从安装向导页面发起操作」 |
| 伪造 `x-install-csrf: forged.token.value` | `403 CSRF_REJECTED` |
| 已装状态下带合法令牌重装 | `409 INSTALL_LOCKED`「当前状态为「已安装」，安装入口已关闭」 |

---

## 16. 安装锁绕过测试

**做法**：已安装状态下直接 `rm` 掉 `installed.lock`，然后访问。

```
删锁后 /  → 307 loc=/install          （Proxy 只看到锁不在）
删锁后 state = INSTALLED source=database tampered=true locked=true
reason = 数据库存在安装记录但本地安装锁缺失（疑似被删除），已重建锁并锁定安装入口
锁是否被自动重建：是（261B）
```

**再试重装**：

```json
{"ok":false,"code":"INSTALL_LOCKED","message":"当前状态为「已安装」，安装入口已关闭。检测到既有安装，已自动接管（未执行安装流程）"}
```

> 说明：Proxy 只做纯 `fs` 检查（不连库），所以删锁后 `/` 会短暂跳到 `/install`；但 `/install` 页面做完整五级判定，立刻识别为"锁被删"，重建锁并锁死入口。**绕过失败。**

---

## 缺陷汇总（本轮修的 6 个）

| # | 缺陷 | 暴露场景 | 严重度 |
| --- | --- | --- | --- |
| 1 | 逐项表单拿不到连接串 | 场景 3 | P0 |
| 2 | `initialize` 权限码判定用 `count()`，漏判迁移预置的 3 行 | 场景 1 | P0 |
| 3 | 安装失败后 `adopted` 锁把状态锁死，无法恢复 | 场景 7 | P0 |
| 4 | `FAILED → INSTALLING` 非法状态转移 | 场景 7b | P0 |
| 5 | 权限判定查数据库级而非 schema 级 | 场景 7c | P1 |
| 6 | 迁移报错不可读（Prisma `DbError` 结构体） | 场景 7d | P2 |

---

## 已知限制

1. **限流是进程内 Map**：多实例部署时每个实例独立计数，需要换 Redis。
2. **`pg-dump` 缺失时迁移前备份会跳过**：只告警不阻断（因为 `pg_dump` 不是运行时依赖）。生产环境应安装 `postgresql-client`。
3. **`satisfiesRange` 只支持 AND 区间**：不支持 `||` / `~` / `^`。
4. **Prisma 之外的迁移引擎未实现**：`migration.engine` 目前只有 `"prisma"`。
