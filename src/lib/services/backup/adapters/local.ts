import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FetchResult, PutResult, StorageAdapter } from "../types";
import { assertSafeBackupPath } from "../paths";

/**
 * 本地暂存盘（规格 16.11.1 P0，但明确「仅暂存、不计异地」）。
 *
 * 用它做两件事：① 备份先落地再上传，上传失败不丢数据；
 * ② 恢复演练直接读本地副本，不依赖远端可用性。
 */
export class LocalAdapter implements StorageAdapter {
  readonly kind = "local";

  constructor(
    private readonly root: string,
    private readonly prefix = "",
  ) {}

  private pathFor(remotePath: string): string {
    assertSafeBackupPath(this.root, "本地备份根目录");
    assertSafeBackupPath(remotePath, "本地备份相对路径");
    const root = resolve(this.root);
    const target = resolve(join(root, remotePath));
    // 防目录穿越：remotePath 来自数据库里的作业元数据，仍然不该无条件信任。
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new Error(`非法的备份路径：${remotePath}`);
    }
    return target;
  }

  async test() {
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    try {
      const probe = this.pathFor(".probe/connectivity.txt");
      await mkdir(dirname(probe), { recursive: true });
      await writeFile(probe, "ok");
      steps.push({ step: "写入测试文件", ok: true });
      const back = await readFile(probe, "utf8");
      steps.push({ step: "读取回校验", ok: back === "ok", detail: back === "ok" ? undefined : "内容不一致" });
      await rm(probe, { force: true });
      steps.push({ step: "删除测试文件", ok: true });
      await rm(dirname(probe), { recursive: true, force: true });
    } catch (error) {
      steps.push({ step: "本地目录不可用", ok: false, detail: (error as Error).message });
    }
    return steps;
  }

  async put(remotePath: string, body: Buffer): Promise<PutResult> {
    const path = this.pathFor(remotePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    const info = await stat(path);
    return { remoteUri: `file://${path}`, sizeBytes: info.size };
  }

  async get(remotePath: string): Promise<FetchResult> {
    return { body: await readFile(this.pathFor(remotePath)) };
  }

  async remove(remotePath: string): Promise<void> {
    await rm(this.pathFor(remotePath), { force: true });
  }

  async capabilities() {
    return { versioning: false, object_lock: false, atomic_move: true, checksum_native: true };
  }
}
