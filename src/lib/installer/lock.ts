/**
 * 安装互斥锁（规格 §六「安装操作使用互斥锁」+ Phase 7「两人同时访问安装页面」）。
 *
 * 实现用 `open(path, 'wx')`：这是 POSIX 上原子的「不存在才创建」，
 * 不需要额外依赖，也不会像 flock 那样在进程崩溃后留下无法清理的内核锁。
 *
 * 崩溃残留靠 stale 判定接管：
 *   - 心跳超过 STALE_MS 未更新 → 视为僵死
 *   - 或者持锁进程已经不在了（process.kill(pid, 0) 抛 ESRCH）
 * 接管时把旧锁改名留档（.stale-<ts>），便于事后查是谁装到一半断了。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const STALE_MS = 90_000;

export interface InstallLockInfo {
  token: string;
  pid: number;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export class InstallLockBusyError extends Error {
  constructor(readonly holder: InstallLockInfo | null) {
    super(
      holder
        ? `另一个安装进程正在运行（pid ${holder.pid}，心跳 ${holder.heartbeatAt}）`
        : "另一个安装进程正在运行",
    );
    this.name = "InstallLockBusyError";
  }
}

function lockFile(dir: string): string {
  return join(dir, "install.lock");
}

export function readInstallLock(dir: string): InstallLockInfo | null {
  const path = lockFile(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as InstallLockInfo;
    if (!raw || typeof raw.token !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM 说明进程存在但属于别人——仍然算活着。
    return code === "EPERM";
  }
}

export function isStale(info: InstallLockInfo, now = Date.now()): boolean {
  const beat = Date.parse(info.heartbeatAt);
  if (!Number.isFinite(beat)) return true;
  if (now - beat > STALE_MS) return true;
  // 只有同一台机器上的 pid 才有意义。
  if (info.host === hostname() && !pidAlive(info.pid)) return true;
  return false;
}

export interface HeldLock {
  info: InstallLockInfo;
  heartbeat(): void;
  release(): void;
}

/**
 * 获取互斥锁。拿不到就抛 InstallLockBusyError（带当前持有者信息）。
 * 僵死锁会被改名留档后接管。
 */
export function acquireInstallLock(dir: string): HeldLock {
  const path = lockFile(dir);
  const now = new Date().toISOString();
  const info: InstallLockInfo = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    acquiredAt: now,
    heartbeatAt: now,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(info, null, 2), null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return makeHeld(dir, info);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const holder = readInstallLock(dir);
      if (holder && !isStale(holder)) {
        throw new InstallLockBusyError(holder);
      }
      // 僵死或损坏：改名留档，下一轮重试创建。
      try {
        renameSync(path, `${path}.stale-${Date.now()}`);
      } catch {
        /* 别人刚清掉，直接重试 */
      }
    }
  }
  throw new InstallLockBusyError(readInstallLock(dir));
}

function makeHeld(dir: string, info: InstallLockInfo): HeldLock {
  const path = lockFile(dir);
  let released = false;

  return {
    info,
    heartbeat() {
      if (released) return;
      info.heartbeatAt = new Date().toISOString();
      try {
        const fd = openSync(path, "w", 0o600);
        try {
          writeSync(fd, JSON.stringify(info, null, 2), null, "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        /* 心跳失败不阻断安装，stale 判定会兜底 */
      }
    },
    release() {
      if (released) return;
      released = true;
      const current = readInstallLock(dir);
      // 只删自己的锁，别把别人的删了。
      if (current && current.token !== info.token) return;
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
