# Universal Installer（从授权系统拆出）

一次性安装向导：探测环境 → 校验配置 → 跑数据库迁移 → 建组织/角色/管理员/签名密钥 → 写安装记录。
阶段 3 之前它长在 Authorization-Management（下称「宿主」）的 `src/lib/installer`、`src/components/install`、
`src/app/install`、`src/app/api/install` 里；现在整体搬到这里，宿主不再挂载它，也不再依赖它的状态。

## 一、这个包负责什么

| 目录 | 内容 |
| --- | --- |
| `app/install/` | 安装页（五级状态判定：锁 / 安装记录 / 项目信号 / 探测 / 默认） |
| `app/api/install/` | 安装接口：`state`（状态）、`probe`（探测）、`run`（执行流水线）、`log`（进度流） |
| `components/install/` | 安装向导 UI 与文案字典（`wizard.tsx`、`i18n.ts`） |
| `lib/installer/` | 核心：契约、状态机、锁、存储、迁移、环境探测、配置写入、编排器、适配器 |
| `host/` | **唯一**与宿主项目耦合的一层（见第二节） |
| `database/` | 本包自己持有的表定义（`installer_records`） |
| `tests/` | 108 条单元测试（6 个文件），可独立运行 |

## 二、与宿主的耦合点（全部集中在 `host/`）

拆分原则是「不反向 import 宿主的 `src/lib` 业务模块」。跨包的东西只有下面四个文件，每个都写了来源：

| 文件 | 来源 | 性质 |
| --- | --- | --- |
| `host/password.ts` | 宿主 `src/lib/auth/password.ts` @ d38c077 抄录 | 逐字副本：scrypt 参数与口令策略必须和宿主一致 |
| `host/permissions.ts` | 宿主 `src/lib/domain/permissions.ts` @ d38c077 抄录 | 逐字副本：权限码表、角色预设 |
| `host/database-url.ts` | 宿主 `src/lib/config.ts` 的 `DEV_DEFAULTS.LICENSE_DB_URL` 规则 | 只抄了「先读 `LICENSE_DB_URL`、否则回落开发默认值」这一条 |
| `host/prisma-client.ts` | 宿主生成物 `src/generated/prisma/client` | **一条相对路径 import**，见下 |

`host/prisma-client.ts` 是唯一指向宿主源码的引用：适配器要建组织、角色、管理员、签名密钥，必须用宿主的模型。
提取成独立仓库时，把那一行换成宿主发布的 client 包（例如 `import { PrismaClient } from "@your-org/licensing-prisma"`）即可，
其余文件不需要改。

副本同步规则：宿主侧改了 `password.ts` / `permissions.ts`，这里必须跟着改；构建期没有联动检查。

## 三、数据归属：`installer_records` 只搬家，不删不动

- 宿主 `prisma/schema.prisma` 里的 `model installer_records` 已删除，**表本身与数据保留**。
- 宿主的迁移 `20261113000000_installer_records_handoff/migration.sql` 是一条**故意什么都不做**的空迁移：
  Prisma 按 schema 差异自动生成的迁移会带 `DROP TABLE "installer_records";`，那样已部署实例的安装记录就没了；
  这条迁移只登记「归属变更」，不执行任何 DDL。
- 本包的 `database/installer_records.sql` 是幂等的 `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`，
  与历史迁移 `20261104120000_installer_records` 的 DDL 完全一致；对已有表执行是空操作，不会改动任何行。
- 写入路径：`lib/installer/adapters/licensing-saas/index.ts` 的 `recordInstall()` 从
  `db.installer_records.upsert()`（Prisma 模型）改成原生 SQL `INSERT ... ON CONFLICT (project_id) DO UPDATE`，
  因为宿主 schema 里已经没有那个模型句柄了。

验证与回滚见 `docs/handoff.md`（宿主仓）第 2.4 节，独立成仓清单见本文第五节。

## 四、本地运行

```bash
# 独立跑本包的单元测试（不需要宿主仓库的 vitest 配置）
cd packages/universal-installer && npx vitest run

# 只做类型检查
cd packages/universal-installer && npx tsc -p tsconfig.json --noEmit
```

依赖由宿主仓库的 `node_modules` 提供（根 tsconfig 的 `include: ["**/*.ts"]` 也会把它们一起 typecheck），
所以当前不需要 `npm install`。独立成仓后需要自己的 lockfile 与 CI。

## 五、还没做完的（独立成仓清单）

1. `host/prisma-client.ts` 换成宿主发布的 client 包（或改成注入 `PrismaClient` 工厂），去掉相对路径。
2. 适配器里的项目假设（表名、权限码、角色 slug、迁移目录）抽成「宿主描述文件」，让第二个项目能复用而不改代码。
3. 打包与发布：`tsc` 出 `dist/`（或直接发布 TS）、版本号策略、CHANGELOG、LICENSE。
4. 独立仓库的 CI：lint + typecheck + vitest + 一个真起 Postgres 的集成用例。
5. 安装页与 API 路由的承载方式：当前是宿主 Next 应用的目录结构，独立后要么做成可挂载子应用，要么自带 Next 应用壳。
6. `database/installer_records.sql` 的手工执行要接进 `orchestrator` 的迁移步骤（现在宿主的历史迁移会建表，所以还没暴露）。
7. 宿主侧文档里对安装器的描述（README / docs/handoff.md）继续按「已拆出」维护，别再写成宿主功能。
