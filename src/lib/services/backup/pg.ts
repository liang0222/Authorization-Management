import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "@/lib/config";
import { BackupAdapterError } from "./types";

const run = promisify(execFile);

/**
 * 数据库导出/恢复的执行层。
 *
 * 这里有个真实的坑：`pg_dump` 大版本必须 >= 服务端版本，否则直接拒绝导出
 * （`aborting because of server version mismatch`）。开发环境服务端是 PostgreSQL 16，
 * 而 Debian 12 仓库里的客户端是 15，于是两条路都留着：
 *
 * 1. 优先用容器内的 pg_dump（`BACKUP_PG_CONTAINER`，默认 `licensing-pg`）——版本天然对齐；
 * 2. 容器不可用时退回本机 pg_dump，版本不匹配会明确报错，而不是导出一个半截文件。
 *
 * 另外 Prisma 的连接串带 `?schema=public`，libpq 不认识这个参数，必须剥掉。
 */
const DEFAULT_CONTAINER = process.env.BACKUP_PG_CONTAINER ?? "licensing-pg";

export interface DumpOutput {
  buffer: Buffer;
  toolVersion: string;
  strategy: "docker" | "local";
}

function libpqUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}

async function dockerAvailable(container: string): Promise<string | null> {
  try {
    const { stdout } = await run("docker", ["exec", container, "pg_dump", "--version"], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function pgDump(): Promise<DumpOutput> {
  const parsed = new URL(config.databaseUrl);
  const containerVersion = await dockerAvailable(DEFAULT_CONTAINER);

  if (containerVersion) {
    // 不能直接把 Prisma 连接串丢给 pg_dump：libpq 既不认 `?schema=` 参数，
    // 也不该在容器内回连宿主机 IP。容器里就用本地 socket + 显式用户名/库名。
    const { stdout } = await run(
      "docker",
      [
        "exec", "-e", `PGPASSWORD=${decodeURIComponent(parsed.password)}`, DEFAULT_CONTAINER,
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--compress=6",
        "--username", decodeURIComponent(parsed.username),
        "--dbname", parsed.pathname.replace(/^\//, ""),
      ],
      { timeout: 10 * 60_000, maxBuffer: 512 * 1024 * 1024, encoding: "buffer" },
    );
    return { buffer: Buffer.from(stdout), toolVersion: containerVersion, strategy: "docker" };
  }

  const { stdout: versionOut } = await run("pg_dump", ["--version"], { timeout: 10_000 }).catch(() => {
    throw new BackupAdapterError("PG_DUMP_MISSING", "本机没有 pg_dump，也无法连接备份容器");
  });
  const { stdout } = await run(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", "--compress=6", "--dbname", libpqUrl(config.databaseUrl)],
    {
      timeout: 10 * 60_000,
      maxBuffer: 512 * 1024 * 1024,
      encoding: "buffer",
      env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
    },
  ).catch((error: Error) => {
    throw new BackupAdapterError("PG_DUMP_FAILED", error.message);
  });
  return { buffer: Buffer.from(stdout), toolVersion: versionOut.trim(), strategy: "local" };
}

export interface RestoreCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RestoreOutcome {
  ok: boolean;
  checks: RestoreCheck[];
  rtoSeconds: number;
}

/**
 * 隔离恢复演练：把备份恢复进一个临时数据库，跑几条对账查询，然后删掉。
 *
 * 关键点是「真的恢复」：只校验 SHA-256 只能证明文件没坏，
 * 证明不了这个备份能被数据库吃下去、也证明不了里面的数据是对的。
 */
export async function restoreIntoScratch(dump: Buffer, expected: { tables: number; licenses: number }): Promise<RestoreOutcome> {
  const startedAt = Date.now();
  const scratch = `licensing_restore_${Date.now().toString(36)}`;
  const checks: RestoreCheck[] = [];
  const containerVersion = await dockerAvailable(DEFAULT_CONTAINER);

  const exec = async (args: string[], input?: Buffer) =>
    run(
      "docker",
      ["exec", "-i", DEFAULT_CONTAINER, ...args],
      { timeout: 10 * 60_000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer", ...(input ? {} : {}) },
    );

  try {
    if (!containerVersion) {
      throw new BackupAdapterError("RESTORE_UNAVAILABLE", "恢复演练需要容器内的 pg_restore（版本需与备份一致）");
    }

    await exec(["createdb", "-U", "licensing", scratch]);
    checks.push({ name: "创建临时数据库", ok: true, detail: scratch });

    // 用 stdin 传输，避免在容器里落一份明文 dump。
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "docker",
        ["exec", "-i", DEFAULT_CONTAINER, "pg_restore", "--no-owner", "--no-privileges", "--dbname", scratch, "-U", "licensing"],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        // pg_restore 对「已存在对象」等非致命问题会返回非零但数据仍完整，
        // 因此这里不当场判死，交给后面的对账查询定论。
        if (code !== 0) checks.push({ name: "pg_restore 退出码", ok: false, detail: `code=${code} ${stderr.slice(0, 300)}` });
        resolve();
      });
      child.stdin.end(dump);
    });

    const tables = await exec(["psql", "-U", "licensing", "-d", scratch, "-tAc", "select count(*) from information_schema.tables where table_schema = 'public'"]);
    const tableCount = Number(tables.stdout.toString().trim());
    checks.push({
      name: "表数量对账",
      ok: tableCount >= expected.tables - 2,
      detail: `恢复后 ${tableCount} 张，线上 ${expected.tables} 张`,
    });

    const licenses = await exec(["psql", "-U", "licensing", "-d", scratch, "-tAc", "select count(*) from licenses"]);
    const licenseCount = Number(licenses.stdout.toString().trim());
    checks.push({
      name: "授权行数对账",
      ok: licenseCount === expected.licenses,
      detail: `恢复后 ${licenseCount} 行，备份时 ${expected.licenses} 行`,
    });

    // 授权码单独存在 license_keys（licenses 表里只有授权主体本身），
    // 这里连查两张表：缺任一行的授权都说明备份不完整。
    const integrity = await exec([
      "psql", "-U", "licensing", "-d", scratch, "-tAc",
      "select (select count(*) from licenses where id is null) + (select count(*) from license_keys where key_hash is null) + (select count(*) from license_keys k left join licenses l on l.id = k.license_id where l.id is null)",
    ]);
    const brokenRows = Number(integrity.stdout.toString().trim());
    checks.push({ name: "关键列完整性", ok: brokenRows === 0, detail: `异常行 ${brokenRows}` });
  } catch (error) {
    checks.push({ name: "恢复失败", ok: false, detail: (error as Error).message });
  } finally {
    await exec(["dropdb", "--if-exists", "-U", "licensing", scratch]).catch(() => null);
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
    rtoSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}
