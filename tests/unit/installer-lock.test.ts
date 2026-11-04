import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireInstallLock,
  InstallLockBusyError,
  isStale,
  readInstallLock,
  STALE_MS,
} from "@/lib/installer/lock";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("安装互斥锁", () => {
  it("第一次获取成功，第二次被拒绝", () => {
    const held = acquireInstallLock(dir);
    expect(held.info.token).toBeTruthy();
    expect(held.info.pid).toBe(process.pid);

    expect(() => acquireInstallLock(dir)).toThrow(InstallLockBusyError);
    held.release();
  });

  it("释放后可以再次获取", () => {
    const first = acquireInstallLock(dir);
    first.release();
    const second = acquireInstallLock(dir);
    expect(second.info.token).not.toBe(first.info.token);
    second.release();
  });

  it("重复 release 不会误删别人的锁", () => {
    const first = acquireInstallLock(dir);
    first.release();
    const second = acquireInstallLock(dir);
    first.release(); // 旧持有者再放一次
    expect(readInstallLock(dir)!.token).toBe(second.info.token);
    second.release();
  });

  it("锁文件权限是 0600", () => {
    const held = acquireInstallLock(dir);
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(join(dir, "install.lock")).mode & 0o777).toBe(0o600);
    held.release();
  });

  it("心跳会更新 heartbeatAt", async () => {
    const held = acquireInstallLock(dir);
    const before = readInstallLock(dir)!.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    held.heartbeat();
    const after = readInstallLock(dir)!.heartbeatAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    held.release();
  });

  it("心跳超时判定为僵死", () => {
    const now = Date.now();
    const stale = {
      token: "t",
      pid: process.pid,
      host: "h",
      acquiredAt: new Date(now - STALE_MS * 3).toISOString(),
      heartbeatAt: new Date(now - STALE_MS - 1000).toISOString(),
    };
    expect(isStale(stale)).toBe(true);
  });

  it("心跳新鲜时不算僵死", () => {
    const fresh = {
      token: "t",
      pid: process.pid,
      host: "h",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    expect(isStale(fresh)).toBe(false);
  });

  it("同机 pid 已死也算僵死（进程被 kill -9 的场景）", () => {
    const dead = {
      token: "t",
      // pid 1 一定活着，这里用一个几乎不可能存在的 pid
      pid: 4_000_000,
      host: require("node:os").hostname() as string,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    expect(isStale(dead)).toBe(true);
  });

  it("僵死锁会被接管，并保留 .stale- 备份", () => {
    const stale = {
      token: "dead-token",
      pid: 4_000_000,
      host: require("node:os").hostname() as string,
      acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
    };
    writeFileSync(join(dir, "install.lock"), JSON.stringify(stale));

    const held = acquireInstallLock(dir);
    expect(held.info.token).not.toBe("dead-token");

    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(dir).some((name) => name.startsWith("install.lock.stale-"))).toBe(true);
    held.release();
  });

  it("锁文件损坏时视为无锁（不阻塞安装）", () => {
    writeFileSync(join(dir, "install.lock"), "garbage");
    expect(readInstallLock(dir)).toBeNull();
    const held = acquireInstallLock(dir);
    held.release();
  });

  it("release 后锁文件消失", () => {
    const held = acquireInstallLock(dir);
    expect(existsSync(join(dir, "install.lock"))).toBe(true);
    held.release();
    expect(existsSync(join(dir, "install.lock"))).toBe(false);
  });

  it("锁内容可读且字段完整", () => {
    const held = acquireInstallLock(dir);
    const raw = JSON.parse(readFileSync(join(dir, "install.lock"), "utf8")) as Record<string, unknown>;
    for (const key of ["token", "pid", "host", "acquiredAt", "heartbeatAt"]) {
      expect(raw[key], key).toBeDefined();
    }
    held.release();
  });
});
