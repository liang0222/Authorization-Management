import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRunInstall } from "../lib/installer/state";
import {
  appendLog,
  atomicWrite,
  buildSnapshot,
  checksumOf,
  dataRoot,
  projectDataDir,
  readLock,
  readLog,
  readState,
  redact,
  resetProjectState,
  writeLock,
  writeState,
} from "../lib/installer/store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("数据目录定位", () => {
  it("默认根目录在 /var/lib/universal-installer", () => {
    const saved = process.env.INSTALLER_DATA_DIR;
    delete process.env.INSTALLER_DATA_DIR;
    expect(dataRoot()).toBe("/var/lib/universal-installer");
    if (saved !== undefined) process.env.INSTALLER_DATA_DIR = saved;
  });

  it("INSTALLER_DATA_DIR 可覆盖", () => {
    const saved = process.env.INSTALLER_DATA_DIR;
    process.env.INSTALLER_DATA_DIR = "/tmp/custom-root";
    expect(dataRoot()).toBe("/tmp/custom-root");
    if (saved === undefined) delete process.env.INSTALLER_DATA_DIR;
    else process.env.INSTALLER_DATA_DIR = saved;
  });

  it("项目 id 带路径分隔符直接抛错（防穿越）", () => {
    expect(() => projectDataDir("../etc")).toThrow();
    expect(() => projectDataDir("a/b")).toThrow();
    expect(() => projectDataDir("Bad-Id")).toThrow();
  });

  it("合法 id 落在根目录之下", () => {
    const path = projectDataDir("licensing-saas");
    expect(path.startsWith(dataRoot())).toBe(true);
    expect(path.endsWith("/licensing-saas")).toBe(true);
  });
});

describe("原子写", () => {
  it("写入内容与权限都正确", () => {
    const path = join(dir, "a.txt");
    atomicWrite(path, "hello");
    expect(readFileSync(path, "utf8")).toBe("hello");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("覆盖写不会残留临时文件", () => {
    const path = join(dir, "b.txt");
    atomicWrite(path, "one");
    atomicWrite(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    // 目录里只应有目标文件本身
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("支持自定义权限（配置文件用 0600，目录用 0700）", () => {
    const path = join(dir, "c.env");
    atomicWrite(path, "A=1", 0o640);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });
});

describe("校验和与安装锁", () => {
  const base = {
    projectId: "licensing-saas",
    projectVersion: "1.5.0",
    installerVersion: "1.0.0",
    installedAt: "2026-11-04T00:00:00.000Z",
    recordId: null,
    adopted: false,
  };

  it("写锁后能读回，校验和匹配", () => {
    writeLock(dir, base);
    const lock = readLock(dir);
    expect(lock).not.toBeNull();
    expect(lock!.projectId).toBe("licensing-saas");
    expect(lock!.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(lock!.checksum).toBe(checksumOf({ ...base }));
  });

  it("锁文件被改过 → 校验和 MISMATCH", () => {
    writeLock(dir, base);
    const path = join(dir, "installed.lock");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    parsed.projectVersion = "9.9.9";
    writeFileSync(path, JSON.stringify(parsed, null, 2));
    expect(readLock(dir)!.checksum).toBe("MISMATCH");
  });

  it("锁文件不是合法 JSON → 返回 null 而不是抛错", () => {
    writeFileSync(join(dir, "installed.lock"), "{ not json");
    expect(readLock(dir)).toBeNull();
  });

  it("没有锁文件时返回 null", () => {
    expect(readLock(dir)).toBeNull();
  });
});

describe("状态文件", () => {
  it("写读往返", () => {
    writeState(dir, {
      state: "INSTALLING",
      projectId: "licensing-saas",
      installerVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
      reason: "test",
    });
    const state = readState(dir);
    expect(state!.state).toBe("INSTALLING");
    expect(state!.reason).toBe("test");
  });

  it("没有状态文件时返回 null", () => {
    expect(readState(dir)).toBeNull();
  });

  it("resetProjectState 会清掉状态与锁", () => {
    writeState(dir, {
      state: "INSTALLED",
      projectId: "licensing-saas",
      installerVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    writeLock(dir, {
      projectId: "licensing-saas",
      projectVersion: "1.5.0",
      installerVersion: "1.0.0",
      installedAt: "2026-11-04T00:00:00.000Z",
      recordId: null,
      adopted: false,
    });
    resetProjectState(dir);
    expect(readState(dir)).toBeNull();
    expect(readLock(dir)).toBeNull();
  });
});

describe("日志与脱敏", () => {
  it("appendLog 落盘且 readLog 能按行取回", () => {
    appendLog(dir, { level: "info", message: "第一步" });
    appendLog(dir, { level: "error", message: "第二步" });
    const lines = readLog(dir, 10);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).message).toBe("第一步");
    expect(JSON.parse(lines[1]).level).toBe("error");
  });

  it("readLog 只返回最后 N 行", () => {
    for (let i = 0; i < 20; i += 1) appendLog(dir, { level: "info", message: `第 ${i} 行` });
    expect(readLog(dir, 5).length).toBe(5);
  });

  it("redact 抹掉连接串里的用户名与密码", () => {
    const text = redact("连接 postgresql://user:s3cret@db:5432/app 失败");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("user");
    expect(text).toContain("@db:5432/app");
  });

  it("redact 抹掉 password= 与 JSON 里的密码", () => {
    expect(redact('password=abc123')).not.toContain("abc123");
    expect(redact('{"password":"abc123"}')).not.toContain("abc123");
  });

  it("redact 抹掉 scrypt 哈希与私钥块", () => {
    const hash = "scrypt$16384$8$1$c2FsdA$aGFzaA";
    expect(redact(hash)).not.toContain("scrypt$16384");
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----";
    expect(redact(pem)).not.toContain("MIIBVQ");
  });

  it("redact 不动普通文本", () => {
    expect(redact("数据库连接成功")).toBe("数据库连接成功");
  });
});

describe("buildSnapshot 五级判定", () => {
  const meta = { projectId: "licensing-saas", projectVersion: "1.5.0" };

  it("无锁、探测说库连不上 → UNKNOWN，且禁止安装", () => {
    const snapshot = buildSnapshot(dir, { ...meta, probe: null, dbRecord: null });
    expect(snapshot.state).toBe("UNKNOWN");
    expect(snapshot.source).toBe("probe");
  });

  it("无锁、探测说没装 → UNINSTALLED", () => {
    const snapshot = buildSnapshot(dir, {
      ...meta,
      probe: { installed: false, evidence: ["0 张表"] },
      dbRecord: null,
    });
    expect(snapshot.state).toBe("UNINSTALLED");
  });

  it("无锁、探测说有业务数据 → INSTALLED(adopted) 并自动写锁", () => {
    const snapshot = buildSnapshot(dir, {
      ...meta,
      probe: { installed: true, evidence: ["41 张表"] },
      dbRecord: null,
    });
    expect(snapshot.state).toBe("INSTALLED");
    expect(snapshot.source).toBe("adopted");
    expect(snapshot.adopted).toBe(true);
    // 关键：自适配必须把锁落盘，否则每次请求都会重新探测数据库
    expect(readLock(dir)).not.toBeNull();
  });

  it("锁丢了但数据库里有安装记录 → INSTALLED(database) 且标 tampered", () => {
    const snapshot = buildSnapshot(dir, {
      ...meta,
      probe: { installed: true, evidence: ["41 张表"] },
      dbRecord: { installedAt: "2026-11-01T00:00:00.000Z", projectVersion: "1.5.0" },
    });
    expect(snapshot.state).toBe("INSTALLED");
    expect(snapshot.source).toBe("database");
    expect(snapshot.tampered).toBe(true);
  });

  it("有锁 → 直接 INSTALLED，不依赖探测结果", () => {
    writeLock(dir, {
      projectId: "licensing-saas",
      projectVersion: "1.5.0",
      installerVersion: "1.0.0",
      installedAt: "2026-11-04T00:00:00.000Z",
      recordId: null,
      adopted: false,
    });
    const snapshot = buildSnapshot(dir, { ...meta, probe: null, dbRecord: null });
    expect(snapshot.state).toBe("INSTALLED");
    expect(snapshot.source).toBe("lock");
    expect(snapshot.tampered).toBe(false);
  });
});

describe("安装失败后的恢复不被 adopted 锁压制", () => {
  const meta = { projectId: "licensing-saas", projectVersion: "1.5.0" };

  it("FAILED 状态下，adopted 锁不再把状态改回 INSTALLED", () => {
    // 模拟真实事故：先自动接管写了一把 adopted 锁，随后安装失败。
    writeLock(dir, {
      projectId: "licensing-saas",
      projectVersion: "1.5.0",
      installerVersion: "1.0.0",
      installedAt: "2026-11-04T11:08:05.676Z",
      recordId: null,
      adopted: true,
    });
    writeState(dir, {
      state: "FAILED",
      projectId: "licensing-saas",
      installerVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
      reason: "安装失败于「initialize」",
    });

    const snapshot = buildSnapshot(dir, {
      ...meta,
      probe: { installed: true, evidence: ["42 张表"] },
      dbRecord: null,
    });
    expect(snapshot.state).toBe("FAILED");
    // 页面据此决定是否允许继续安装；FAILED 必须放行
    expect(canRunInstall(snapshot.state)).toBe(true);
  });

  it("INSTALLING 状态同样不被 adopted 锁压制", () => {
    writeLock(dir, {
      projectId: "licensing-saas",
      projectVersion: "1.5.0",
      installerVersion: "1.0.0",
      installedAt: "2026-11-04T11:08:05.676Z",
      recordId: null,
      adopted: true,
    });
    writeState(dir, {
      state: "INSTALLING",
      projectId: "licensing-saas",
      installerVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    expect(buildSnapshot(dir, { ...meta, probe: null, dbRecord: null }).state).toBe("INSTALLING");
  });

  it("非 adopted 的真实安装锁仍然优先（装完就是装完了）", () => {
    writeLock(dir, {
      projectId: "licensing-saas",
      projectVersion: "1.5.0",
      installerVersion: "1.0.0",
      installedAt: "2026-11-04T11:08:05.676Z",
      recordId: null,
      adopted: false,
    });
    writeState(dir, {
      state: "INSTALLED",
      projectId: "licensing-saas",
      installerVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    const snapshot = buildSnapshot(dir, { ...meta, probe: null, dbRecord: null });
    expect(snapshot.state).toBe("INSTALLED");
    expect(snapshot.source).toBe("lock");
  });
});
