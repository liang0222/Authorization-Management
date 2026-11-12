/**
 * 迁移调度（规格 §七）。
 *
 * 关键决策：**不自己造迁移系统**。规格明确「如果现有项目已经有成熟的 Migration 系统，
 * 优先适配，不要重新造一个冲突的迁移系统」。本项目用 Prisma Migrate，所以这里只做
 * 三件事：
 *   1. 迁移前按需备份（pg_dump -Fc，失败不阻断但要如实记录）；
 *   2. 调 `prisma migrate deploy`（它自身幂等，且带 _prisma_migrations 记录）；
 *   3. 读回 `_prisma_migrations` 给出「已应用 / 本次新增」的清单。
 *
 * 所有子进程都带超时与输出上限，避免装到一半挂死。
 */
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { withClient } from "./database";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** 输出上限，超出截断（保留尾部，报错通常在尾部）。 */
  maxBytes?: number;
}

/** 跑一条命令，永不抛异常——失败也是结果。 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const { cwd, env = {}, timeoutMs = 300_000, maxBytes = 256 * 1024 } = options;

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({
        code: null,
        stdout: "",
        stderr: (error as Error).message,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code,
        stdout: stdout.slice(-maxBytes),
        stderr: stderr.slice(-maxBytes),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxBytes * 2) stdout = stdout.slice(-maxBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > maxBytes * 2) stderr = stderr.slice(-maxBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

export interface AppliedMigration {
  name: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
  logs: string | null;
}

export async function listAppliedMigrations(databaseUrl: string): Promise<AppliedMigration[]> {
  return withClient(databaseUrl, async (client) => {
    const exists = await client.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema='public' and table_name='_prisma_migrations'",
    );
    if (Number(exists.rows[0]?.count ?? 0) === 0) return [];
    const { rows } = await client.query<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
      logs: string | null;
    }>(
      "select migration_name, finished_at, rolled_back_at, logs from _prisma_migrations order by started_at asc",
    );
    return rows.map((r) => ({
      name: r.migration_name,
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      rolledBackAt: r.rolled_back_at ? new Date(r.rolled_back_at).toISOString() : null,
      logs: r.logs,
    }));
  });
}

export interface BackupResult {
  status: "created" | "skipped" | "failed";
  path?: string;
  bytes?: number;
  reason?: string;
}

/**
 * 迁移前备份。只在「库里已经有表」时才做——空库没有可备份的东西。
 * pg_dump 缺失或失败都不阻断安装（规格允许，但必须如实记录）。
 */
export async function backupBeforeMigrate(options: {
  databaseUrl: string;
  dataDir: string;
  projectDir: string;
  hasExistingTables: boolean;
}): Promise<BackupResult> {
  if (!options.hasExistingTables) {
    return { status: "skipped", reason: "目标库为空，无需备份" };
  }

  const version = await runCommand("pg_dump", ["--version"], { cwd: options.projectDir, timeoutMs: 8000 });
  if (version.code !== 0) {
    return { status: "skipped", reason: "未找到 pg_dump，跳过迁移前备份（安装器会在日志中标记）" };
  }

  const dir = join(options.dataDir, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `pre-migrate-${new Date().toISOString().replace(/[:.]/g, "")}.dump`);

  const result = await runCommand(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl", `--file=${path}`, options.databaseUrl],
    { cwd: options.projectDir, timeoutMs: 600_000 },
  );

  if (result.code !== 0) {
    return {
      status: "failed",
      reason: (result.stderr || "pg_dump 执行失败").split("\n").slice(-3).join(" ").slice(0, 500),
    };
  }

  try {
    const st = statSync(path);
    return { status: "created", path, bytes: st.size };
  } catch {
    return { status: "failed", reason: "备份文件未生成" };
  }
}

export interface PrismaMigrateOptions {
  projectDir: string;
  databaseUrl: string;
  /** 迁移前库里已有表 → 先备份。 */
  hasExistingTables: boolean;
  dataDir: string;
  timeoutMs?: number;
}

export interface PrismaMigrateOutcome {
  ok: boolean;
  applied: string[];
  alreadyApplied: string[];
  backup: BackupResult;
  message: string;
  rawOutput?: string;
}

/**
 * 用项目自带的 Prisma Migrate 执行迁移。
 * `migrate deploy` 本身幂等：已应用的不会重跑，因此恢复流程可以放心重放。
 */
export async function runPrismaMigrate(
  options: PrismaMigrateOptions,
): Promise<PrismaMigrateOutcome> {
  const backup = await backupBeforeMigrate({
    databaseUrl: options.databaseUrl,
    dataDir: options.dataDir,
    projectDir: options.projectDir,
    hasExistingTables: options.hasExistingTables,
  });

  const before = await listAppliedMigrations(options.databaseUrl).catch(() => [] as AppliedMigration[]);
  const beforeNames = new Set(before.filter((m) => m.finishedAt && !m.rolledBackAt).map((m) => m.name));

  // 用项目本地的 prisma CLI（node_modules/.bin），避免 npx 去 npm 拉一个不同大版本回来。
  const result = await runCommand(
    join(options.projectDir, "node_modules", ".bin", "prisma"),
    ["migrate", "deploy"],
    {
      cwd: options.projectDir,
      env: { LICENSE_DB_URL: options.databaseUrl },
      timeoutMs: options.timeoutMs ?? 600_000,
    },
  );

  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-8).join("\n");
    return {
      ok: false,
      applied: [],
      alreadyApplied: [...beforeNames],
      backup,
      message: result.timedOut
        ? `迁移超时（${Math.round((options.timeoutMs ?? 600_000) / 1000)}s）`
        : `迁移失败：${tail || "prisma migrate deploy 返回非零退出码"}`,
      rawOutput: tail,
    };
  }

  const after = await listAppliedMigrations(options.databaseUrl).catch(() => [] as AppliedMigration[]);
  const appliedNames = after.filter((m) => m.finishedAt && !m.rolledBackAt).map((m) => m.name);
  const newlyApplied = appliedNames.filter((n) => !beforeNames.has(n));

  return {
    ok: true,
    applied: newlyApplied,
    alreadyApplied: appliedNames.filter((n) => beforeNames.has(n)),
    backup,
    message:
      newlyApplied.length > 0
        ? `应用 ${newlyApplied.length} 个迁移（共 ${appliedNames.length} 个）`
        : `迁移已是最新（共 ${appliedNames.length} 个）`,
  };
}
