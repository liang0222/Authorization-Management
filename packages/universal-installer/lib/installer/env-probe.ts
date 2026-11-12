/**
 * 环境检测（规格 §五 第 4 步 + Layer 4 Deployment Runtime）。
 *
 * 只做「读」和「试探」，绝不修改系统。任何一项失败都只是 CheckItem，
 * 由核心决定是阻断还是仅警告——检测本身不抛异常。
 */
import { accessSync, constants, readFileSync, statfsSync, statSync } from "node:fs";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CheckItem } from "./contract";
import { parseSemver, satisfiesRange } from "./manifest";

export interface ProbeOptions {
  projectDir: string;
  dataDir: string;
  /** Manifest 里声明需要可写的相对路径。 */
  writablePaths?: string[];
  /** 需要 Node 版本满足的 range，来自 package.json engines。 */
  nodeRange?: string;
  /** 期望监听的端口（只检查是否被自己占用，不阻止安装）。 */
  expectedPort?: number;
}

function ok(id: string, title: string, detail: string): CheckItem {
  return { id, title, status: "ok", detail };
}
function warn(id: string, title: string, detail: string, hint?: string): CheckItem {
  return { id, title, status: "warn", detail, hint };
}
function fail(id: string, title: string, detail: string, hint?: string): CheckItem {
  return { id, title, status: "fail", detail, hint };
}

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 磁盘剩余空间（MB）。statfs 在部分文件系统上会失败，失败就返回 null。 */
function freeDiskMb(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    return Math.round((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/** 带超时地跑一条命令，只用于「在不在」这类探测。 */
function runQuiet(cmd: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (result: { ok: boolean; stdout: string }) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done({ ok: false, stdout: "" });
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stdout: out });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 4096) out = out.slice(0, 4096);
    });
    child.on("error", () => {
      clearTimeout(timer);
      done({ ok: false, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, stdout: out.trim() });
    });
  });
}

export async function probeEnvironment(options: ProbeOptions): Promise<CheckItem[]> {
  const checks: CheckItem[] = [];
  const { projectDir, dataDir, writablePaths = [] } = options;

  /* ---- 运行时 ---- */
  const nodeVersion = process.versions.node;
  if (options.nodeRange) {
    const parsed = parseSemver(nodeVersion);
    const satisfied = parsed ? satisfiesRange(nodeVersion, options.nodeRange) : false;
    checks.push(
      satisfied
        ? ok("node-version", "Node.js 版本", `${nodeVersion} 满足要求 ${options.nodeRange}`)
        : fail(
            "node-version",
            "Node.js 版本",
            `当前 ${nodeVersion}，项目要求 ${options.nodeRange}`,
            "升级 Node.js 后重启服务再安装",
          ),
    );
  } else {
    checks.push(ok("node-version", "Node.js 版本", nodeVersion));
  }

  checks.push(
    ok(
      "runtime",
      "操作系统",
      `${platform()} ${release()} · ${hostname()} · ${cpus().length} 核 · 内存 ${Math.round(
        freemem() / 1024 / 1024,
      )}MB 可用 / ${Math.round(totalmem() / 1024 / 1024)}MB 总计`,
    ),
  );

  /* ---- 项目目录 ---- */
  if (!dirExists(projectDir)) {
    checks.push(
      fail("project-dir", "项目目录", `不存在：${projectDir}`, "确认部署目录与服务的工作目录一致"),
    );
  } else if (!canWrite(projectDir)) {
    checks.push(
      warn(
        "project-dir",
        "项目目录",
        `存在但当前用户不可写：${projectDir}`,
        "构建产物与密钥目录需要写入权限；以 root 或对应属主运行安装",
      ),
    );
  } else {
    checks.push(ok("project-dir", "项目目录", projectDir));
  }

  /* ---- 安装器数据目录 ---- */
  const dataExists = dirExists(dataDir);
  if (!dataExists && !canWrite(resolve(dataDir, ".."))) {
    checks.push(
      fail(
        "data-dir",
        "安装器数据目录",
        `不存在且父目录不可写：${dataDir}`,
        "用 root 运行，或设置 INSTALLER_DATA_DIR 指向可写目录",
      ),
    );
  } else if (dataExists && !canWrite(dataDir)) {
    checks.push(
      fail("data-dir", "安装器数据目录", `存在但不可写：${dataDir}`, "检查目录属主与权限（应为 0700）"),
    );
  } else {
    checks.push(ok("data-dir", "安装器数据目录", `${dataDir}（${dataExists ? "已存在" : "待创建"}）`));
  }

  /* ---- 磁盘 ---- */
  const freeMb = freeDiskMb(dirExists(dataDir) ? dataDir : projectDir);
  if (freeMb === null) {
    checks.push(warn("disk", "磁盘空间", "无法读取磁盘剩余空间"));
  } else if (freeMb < 512) {
    checks.push(
      fail("disk", "磁盘空间", `仅剩 ${freeMb}MB`, "至少留 512MB 给依赖、构建产物与备份"),
    );
  } else if (freeMb < 2048) {
    checks.push(warn("disk", "磁盘空间", `剩余 ${freeMb}MB，建议 2GB 以上`));
  } else {
    checks.push(ok("disk", "磁盘空间", `剩余 ${freeMb}MB`));
  }

  /* ---- 声明需要可写的路径 ---- */
  for (const rel of writablePaths) {
    const abs = resolve(projectDir, rel);
    if (canWrite(abs) || (dirExists(abs) && canWrite(abs))) {
      checks.push(ok(`writable:${rel}`, `可写路径 ${rel}`, abs));
    } else if (!dirExists(abs) && canWrite(resolve(abs, ".."))) {
      checks.push(ok(`writable:${rel}`, `可写路径 ${rel}`, `${abs}（待创建）`));
    } else {
      checks.push(
        warn(
          `writable:${rel}`,
          `可写路径 ${rel}`,
          `不可写：${abs}`,
          "安装时会尝试创建；若失败请手动 mkdir 并 chown",
        ),
      );
    }
  }

  /* ---- 部署形态 ---- */
  const docker = await runQuiet("docker", ["version", "--format", "{{.Server.Version}}"]);
  checks.push(
    docker.ok
      ? ok("docker", "Docker", `可用（服务端 ${docker.stdout || "unknown"}）`)
      : warn("docker", "Docker", "未检测到可用的 Docker", "用 Docker 部署时才需要；裸机部署可忽略"),
  );

  const systemd = await runQuiet("systemctl", ["--version"]);
  checks.push(
    systemd.ok
      ? ok("systemd", "进程管理", systemd.stdout.split("\n")[0] ?? "systemd")
      : warn("systemd", "进程管理", "未检测到 systemd", "改用其他进程管理器时需自行保证重启"),
  );

  const pgDump = await runQuiet("pg_dump", ["--version"]);
  checks.push(
    pgDump.ok
      ? ok("pg-dump", "迁移前备份能力", pgDump.stdout)
      : warn(
          "pg-dump",
          "迁移前备份能力",
          "未找到 pg_dump",
          "库里有既有数据时无法自动备份，安装器会跳过并记录；建议装 postgresql-client",
        ),
  );

  /* ---- 端口 ---- */
  if (options.expectedPort) {
    const busy = await isPortBusy(options.expectedPort);
    checks.push(
      busy
        ? warn(
            "port",
            `端口 ${options.expectedPort}`,
            "已被占用",
            "若是本项目自己的进程则正常；否则换端口或先停掉占用者",
          )
        : ok("port", `端口 ${options.expectedPort}`, "空闲"),
    );
  }

  return checks;
}

/** 只用于展示：端口是否已被监听。 */
export async function isPortBusy(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(true));
    server.once("listening", () => {
      server.close(() => resolvePromise(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

/** 项目根下的 package.json engines.node，用来做运行时版本检查。 */
export function readNodeEngineRange(projectDir: string): string | undefined {
  try {
    const raw = readFileSync(join(projectDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { engines?: { node?: string } };
    const range = pkg.engines?.node;
    if (!range) return undefined;
    // engines 允许 "^22"、"~22.11"、"22.x" 这类写法，这里只处理能映射到 semver range 的形态。
    const normalized = range
      .replace(/\^/g, ">=")
      .replace(/~/, ">=")
      .replace(/\s*\|\|.*$/, "")
      .trim();
    return /\d+\.\d+\.\d+/.test(normalized) ? normalized : `${normalized}.0.0`.replace(/\.0\.0\.0$/, ".0.0");
  } catch {
    return undefined;
  }
}
