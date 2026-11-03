import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "@/lib/config";

const run = promisify(execFile);

/**
 * 数据库导出（规格 16.x 的 scope=database）。
 *
 * 为什么用 pg_dump 而不是「遍历 Prisma 模型导出 JSON」：
 * 备份要能真正恢复成可用数据库，自定义格式（-Fc）保留了类型、约束、索引、函数与序列，
 * 而手写导出会悄悄丢掉这些东西 —— 恢复演练时才会发现，那时已经晚了。
 *
 * 参数里的 --no-owner / --no-privileges 是为了让备份能恢复到不同角色的实例上。
 */
export interface DumpResult {
  /** 加密后的备份体。 */
  body: Buffer;
  /** 未加密的 dump 大小（用于展示「原始数据量」）。 */
  rawBytes: number;
  sha256: string;
  durationMs: number;
  pgDumpVersion: string;
}

export async function dumpDatabase(): Promise<Omit<DumpResult, "body" | "sha256"> & { raw: Buffer }> {
  const startedAt = Date.now();
  const { stdout: versionOut } = await run("pg_dump", ["--version"], { timeout: 10_000 });
  const pgDumpVersion = versionOut.trim();

  const url = config.databaseUrl;
  const args = [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--compress=6",
    "--dbname", url,
  ];

  // 密码通过环境变量传，不放命令行（进程列表会泄露）。
  const { stdout } = await run("pg_dump", args, {
    timeout: 10 * 60_000,
    maxBuffer: 1024 * 1024 * 512,
    env: { ...process.env },
    encoding: "buffer",
  });

  const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  return {
    raw,
    rawBytes: raw.byteLength,
    durationMs: Date.now() - startedAt,
    pgDumpVersion,
  };
}

/** 把备份体写到本地暂存目录，返回路径与大小。 */
export async function writeStagingFile(backupId: string, body: Buffer): Promise<{ path: string; sizeBytes: number }> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = config.backupLocalDir;
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${backupId}.zmbk`;
  await writeFile(path, body, { mode: 0o600 });
  const info = await stat(path);
  return { path, sizeBytes: info.size };
}

export async function readStagingFile(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function removeStagingFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function checksumOf(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
