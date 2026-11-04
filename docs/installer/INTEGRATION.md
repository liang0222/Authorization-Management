# 接入新项目 · Adapter 开发指南

> 目标：让一个**完全不同的技术栈**项目，复用同一套安装核心与安装界面。
> 前提：你只需要实现 9 个方法，不用碰 Core 一行代码。

---

## 0. 目录约定

```
src/lib/installer/
├── contract.ts                 # 你实现的接口定义（只读）
├── manifest.ts                 # Manifest 校验（只读）
├── ...                         # 其余 Core 文件（只读）
└── adapters/
    ├── licensing-saas/         # 本项目参考实现
    │   ├── manifest.ts
    │   └── index.ts
    └── your-project/           # 你要新建的
        ├── manifest.ts
        └── index.ts
```

---

## 1. 写 Manifest

```ts
// src/lib/installer/adapters/your-project/manifest.ts
import type { ProjectManifest } from "@/lib/installer/contract";

export const YOUR_PROJECT_ID = "your-project";

export const yourManifest: ProjectManifest = {
  manifestVersion: "1.0",
  project: {
    id: YOUR_PROJECT_ID,          // ^[a-z0-9][a-z0-9-]*$，会拼进数据目录路径
    name: "你的项目名",
    version: "1.0.0",
    description: "一句话说明",
    accentColor: "#0ea5e9",       // ^#[0-9a-fA-F]{6}$
  },
  adapter: "your-project",
  requiresInstaller: ">=1.0.0 <2.0.0",
  database: {
    type: "postgresql",
    minVersion: "14",
    urlTemplate: "postgresql://{username}:{password}@{host}:{port}/{database}?schema={schema}",
  },
  fields: {
    admin: [
      { key: "email", label: "管理员邮箱", type: "email", required: true },
      { key: "password", label: "密码", type: "password", required: true, secret: true, minLength: 10 },
      { key: "passwordConfirm", label: "确认密码", type: "password", required: true, secret: true },
    ],
    database: [
      { key: "host", label: "主机", type: "text", required: true, default: "127.0.0.1" },
      { key: "port", label: "端口", type: "text", required: true, default: "5432" },
      { key: "database", label: "库名", type: "text", required: true },
      { key: "username", label: "用户名", type: "text", required: true },
      { key: "password", label: "密码", type: "password", required: true, secret: true },
    ],
    system: [
      { key: "appBaseUrl", label: "站点地址", type: "text", required: true },
    ],
  },
  migration: { engine: "prisma", path: "prisma/migrations", backupBeforeMigrate: true },
  i18n: { default: "zh-CN", supported: ["zh-CN", "en-US"] },
  writablePaths: [".keys-prod"],
  successRedirect: "/login",
};
```

**注意**：`secret: true` 的字段**不能有 `default`**，`validateManifest()` 会报错——这是防止把密码写进代码。

---

## 2. 实现 Adapter

```ts
// src/lib/installer/adapters/your-project/index.ts
import type {
  AdapterContext, AdminResult, DetectResult, DatabaseInspection,
  DatabaseTestResult, HealthResult, InitializeResult, InstallerAdapter,
  InstallerConfigInput, MigrationResult, ProjectManifest, ValidationResult,
} from "@/lib/installer/contract";

export class YourAdapter implements InstallerAdapter {
  constructor(private readonly projectDir: string) {}

  async detect(): Promise<DetectResult> { /* 看几个标志文件 */ }

  async getManifest(): Promise<ProjectManifest> { return yourManifest; }

  async validateConfig(input: InstallerConfigInput): Promise<ValidationResult> {
    // 字段级 + 跨字段；返回 { ok, issues: [{field, message}] }，不抛异常
  }

  async testDatabase(input: InstallerConfigInput): Promise<DatabaseTestResult> {
    // 复用 Core：import { testDatabaseConnection } from "@/lib/installer/database";
    return testDatabaseConnection(input);
  }

  async inspectDatabase(input: InstallerConfigInput): Promise<DatabaseInspection> {
    return inspectDatabase(input);
  }

  async runMigrations(ctx: AdapterContext): Promise<MigrationResult> {
    // 复用 Core：runPrismaMigrate({ projectDir: this.projectDir, databaseUrl: ctx.databaseUrl, ... })
  }

  async initialize(ctx: AdapterContext): Promise<InitializeResult> {
    // 幂等：按缺失补齐，不要 TRUNCATE
  }

  async createAdmin(ctx: AdapterContext): Promise<AdminResult> {
    // 先查 email 是否存在；存在则 { ok: true, alreadyExisted: true }，不改密码
  }

  async healthCheck(ctx: AdapterContext): Promise<HealthResult> {
    // 查 1 张核心表 + 1 个管理员 + 1 个可用密钥
  }
}
```

### 幂等清单（必须逐条做到）

| 操作 | 幂等做法 |
| --- | --- |
| 建表 | 交给迁移系统，不要手写 `CREATE TABLE` |
| 权限码 | `findMany` 拿已有集合 → 只补缺失 → `createMany({ skipDuplicates: true })` |
| 组织 | `findFirst({ where: { slug } })` 命中就复用 |
| 角色 | `upsert` 或先查后建 |
| 角色权限 | 查 `count` 为 0 才写，或 `skipDuplicates` |
| 管理员 | 先按 email 查；存在就沿用，**绝不改密码** |
| 签名密钥 | 查 `status = "active"`；有就跳过 |

---

## 3. 接线

```ts
// src/lib/installer/runtime.ts
export function adapter(): InstallerAdapter {
  return new YourAdapter(projectDir());
}
```

同时改 `manifest()` 与 `installDataDir()` 里的 `PROJECT_ID`。

---

## 4. UI 不用改

`src/components/install/wizard.tsx` 完全由 Manifest 驱动：

- 字段、分组、类型、校验规则 → 来自 `manifest.fields`
- 主色 → `manifest.project.accentColor`
- 完成页跳转 → `manifest.successRedirect`
- 步骤条 → 固定 5 段（admin / database / system / review / run），14 个 phase 的进度来自后端

如果你要加自定义字段，只在 Manifest 里加，**不要改 wizard.tsx**。

---

## 5. 非 Prisma 项目怎么办

`migration.engine` 目前支持 `"prisma"`。接别的引擎（Flyway / Knex / Alembic / 手写 SQL）需要：

1. 在 `migrations.ts` 加一个 `runXxxMigrate()`
2. 在 Adapter 的 `runMigrations()` 里调用它
3. 保证「迁移前备份」与「已应用迁移列表」两个能力可用（这是 Phase 7 场景 19 的验收点）

---

## 6. 自测清单

```bash
npx tsc --noEmit
npx vitest run tests/unit
npm run build
```

然后按 `docs/installer/TEST-REPORT.md` 的 17 类场景逐条跑一遍。
