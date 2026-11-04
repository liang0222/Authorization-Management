/**
 * 安装状态的持久化（规格 §六）。
 *
 * 落盘位置：`${INSTALLER_DATA_DIR:-/var/lib/universal-installer}/<projectId>/`
 *   state.json          状态机当前值 + 最近一次尝试
 *   installed.lock      安装锁（规格要求「安装锁」独立成文件）
 *   install.log         逐行 JSON 日志（已脱敏）
 *   attempts/<id>.json  每次尝试的完整步骤记录（恢复凭据）
 *   backups/            迁移前备份
 *   config/             安装器生成的运行配置（env 文件落在这里再由部署层分发）
 *
 * 安全要点：
 * - 目录 0700、文件 0600。
 * - 所有写入走「临时文件 + fsync + rename」，绝不原地改（断电不会留半截 JSON）。
 * - 读取时做校验，坏了不抛异常而是降级为 UNKNOWN，避免一次磁盘抖动把已装实例判成未装。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type {
  InstallAttempt,
  InstallSnapshot,
  InstallState,
  StateSource,
} from "@/lib/installer/contract";
import { INSTALLER_VERSION } from "@/lib/installer/contract";
import { assertTransition } from "@/lib/installer/state";

export const DEFAULT_DATA_ROOT = "/var/lib/universal-installer";

export interface LockFile {
  projectId: string;
  projectVersion: string;
  installerVersion: string;
  installedAt: string;
  /** 数据库里的安装记录 id；自适配的既有实例为 null。 */
  recordId: string | null;
  adopted: boolean;
  /** 内容校验和：只防意外损坏，真正的权威在数据库记录。 */
  checksum: string;
}

export interface StoredState {
  state: InstallState;
  projectId: string;
  projectVersion?: string;
  installerVersion: string;
  updatedAt: string;
  installedAt?: string;
  adopted?: boolean;
  tampered?: boolean;
  lastAttemptId?: string;
  /** 已创建管理员的邮箱；恢复时不允许换人。 */
  adminEmail?: string;
  reason?: string;
}

export function dataRoot(): string {
  const raw = process.env.INSTALLER_DATA_DIR?.trim();
  const root = raw && raw.length > 0 ? raw : DEFAULT_DATA_ROOT;
  return resolve(root);
}

/** 项目标识会拼进路径，必须挡住 `../` 与绝对路径。 */
export function projectDataDir(projectId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error(`非法项目标识：${projectId}`);
  }
  const root = dataRoot();
  const dir = resolve(join(root, projectId));
  // resolve 之后再确认仍在 root 之下，双保险。
  if (dir !== join(root, projectId) || !dir.startsWith(root + "/")) {
    throw new Error(`项目数据目录越界：${dir}`);
  }
  return dir;
}

export function ensureDir(dir: string, mode = 0o700): void {
  mkdirSync(dir, { recursive: true, mode });
  try {
    const st = statSync(dir);
    if ((st.mode & 0o777) !== mode) {
      // 已存在但权限更宽：收紧它。
      chmodSync(dir, mode);
    }
  } catch {
    /* 权限调整失败不阻塞安装，环境检测会报 warn */
  }
}

/** 原子写：同目录临时文件 → fsync → rename。 */
export function atomicWrite(path: string, content: string, mode = 0o600): void {
  const dir = resolve(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${Date.now()}-${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    /* ignore */
  }
}

export function checksumOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function lockPath(dir: string): string {
  return join(dir, "installed.lock");
}
function statePath(dir: string): string {
  return join(dir, "state.json");
}

export function readLock(dir: string): LockFile | null {
  const path = lockPath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LockFile;
    if (!raw || typeof raw !== "object" || typeof raw.projectId !== "string") return null;
    const { checksum, ...rest } = raw;
    if (checksum !== checksumOf(rest)) {
      // 锁文件被改过：仍然认为「装过」，但标记 tampered。
      return { ...raw, checksum: "MISMATCH" };
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeLock(
  dir: string,
  payload: Omit<LockFile, "checksum">,
): LockFile {
  const withChecksum: LockFile = { ...payload, checksum: checksumOf(payload) };
  atomicWrite(lockPath(dir), JSON.stringify(withChecksum, null, 2));
  return withChecksum;
}

export function readState(dir: string): StoredState | null {
  const path = statePath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as StoredState;
    if (!raw || typeof raw.state !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeState(dir: string, next: StoredState): void {
  atomicWrite(statePath(dir), JSON.stringify(next, null, 2));
}

/** 状态迁移的唯一入口：先校验转移合法，再落盘。 */
export function transitionState(
  dir: string,
  projectId: string,
  from: InstallState,
  to: InstallState,
  patch: Partial<StoredState> = {},
): StoredState {
  assertTransition(from, to);
  const prev = readState(dir);
  const next: StoredState = {
    state: to,
    projectId,
    installerVersion: INSTALLER_VERSION,
    updatedAt: new Date().toISOString(),
    projectVersion: patch.projectVersion ?? prev?.projectVersion,
    installedAt: patch.installedAt ?? prev?.installedAt,
    adopted: patch.adopted ?? prev?.adopted,
    tampered: patch.tampered ?? prev?.tampered,
    lastAttemptId: patch.lastAttemptId ?? prev?.lastAttemptId,
    adminEmail: patch.adminEmail ?? prev?.adminEmail,
    reason: patch.reason ?? patch.reason ?? prev?.reason,
  };
  writeState(dir, next);
  return next;
}

/* ------------------------------------------------------------------ 尝试记录 */

export function attemptsDir(dir: string): string {
  return join(dir, "attempts");
}

export function writeAttempt(dir: string, attempt: InstallAttempt): void {
  atomicWrite(
    join(attemptsDir(dir), `${attempt.id}.json`),
    JSON.stringify(attempt, null, 2),
  );
}

export function readAttempt(dir: string, id: string): InstallAttempt | null {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) return null;
  const path = join(attemptsDir(dir), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as InstallAttempt;
  } catch {
    return null;
  }
}

export function latestAttempt(dir: string): InstallAttempt | null {
  const state = readState(dir);
  if (state?.lastAttemptId) {
    const found = readAttempt(dir, state.lastAttemptId);
    if (found) return found;
  }
  return null;
}

/* -------------------------------------------------------------------- 日志 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/gi, "postgresql://***:***@"],
  [/("?(?:password|passwd|pwd|secret|token|privateKey|apiKey)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"'],
  [/((?:password|passwd|pwd|secret|token|privateKey|apiKey)\s*=\s*)\S+/gi, "$1***"],
  [/scrypt\$[^\s"']+/g, "scrypt$***"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***PRIVATE KEY***"],
];

/** 日志与状态里一律脱敏。这条函数是所有出站文本的最后一道闸。 */
export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function appendLog(
  dir: string,
  entry: { level: "info" | "warn" | "error"; phase?: string; message: string; detail?: unknown },
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: entry.level,
    phase: entry.phase,
    message: redact(entry.message),
    detail: entry.detail === undefined ? undefined : JSON.parse(redact(JSON.stringify(entry.detail))),
  });
  const path = join(dir, "install.log");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${line}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readLog(dir: string, maxLines = 200): string[] {
  const path = join(dir, "install.log");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return lines.slice(-maxLines);
}

/* ------------------------------------------------------------------- 快照 */

export interface SnapshotInput {
  projectId: string;
  projectVersion?: string;
  /** 从数据库或适配器探测得到的结论；null 表示「连不上，无法判定」。 */
  probe?: { installed: boolean; evidence: string[] } | null;
  /** 数据库里是否有安装记录。 */
  dbRecord?: { installedAt: string; projectVersion: string } | null;
}

/**
 * 规格 §六：「安装状态使用本地持久化状态和数据库安装记录共同校验」，
 * 且「数据库暂时无法连接时，不能错误地判断项目尚未安装」。
 *
 * 判定顺序（先便宜后昂贵，先权威后推断）：
 *   1. 锁文件在 → INSTALLED（source=lock；校验和不符则 tampered）
 *   2. 数据库有记录 → INSTALLED（source=database）
 *   3. 适配器探测到项目自身已有数据 → INSTALLED（source=adopted，写锁自适配）
 *   4. 探测说连不上（probe === null）→ UNKNOWN（禁止安装）
 *   5. 以上都不成立 → UNINSTALLED
 */
export function buildSnapshot(dir: string, input: SnapshotInput): InstallSnapshot {
  const base: Omit<InstallSnapshot, "state" | "source" | "tampered" | "adopted" | "reason"> = {
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    installerVersion: INSTALLER_VERSION,
    attempt: latestAttempt(dir) ?? undefined,
  };

  /*
   * 先读一次本地状态：判断这次「已装」是不是我们自己装到一半留下的。
   *
   * 真事故：首次安装跑到 initialize 失败，库里已有 42 张表，随后失败分支重新探测，
   * 被判定成 adopted 并写下一把 adopted=true 的锁——此后永远显示「已安装」，
   * 用户再也没法继续安装。规格要求支持失败恢复，所以这里必须先认自己的在途状态。
   */
  const storedState = readState(dir);
  const inFlightState =
    storedState &&
    (storedState.state === "INSTALLING" ||
      storedState.state === "FAILED" ||
      storedState.state === "RECOVERY")
      ? storedState.state
      : null;

  const lock = readLock(dir);
  // adopted 锁是「自动接管」写下的，安装失败后它就不该再压制恢复流程。
  if (lock && !(lock.adopted && inFlightState)) {
    const tampered = lock.checksum === "MISMATCH";
    return {
      ...base,
      state: "INSTALLED",
      source: "lock",
      installedAt: lock.installedAt,
      projectVersion: lock.projectVersion || base.projectVersion,
      tampered,
      adopted: lock.adopted,
      reason: tampered
        ? "安装锁校验和不符（文件被改动过），按已安装处理并锁定安装入口"
        : lock.adopted
          ? "检测到既有安装，已自动接管（未执行安装流程）"
          : "本地安装锁存在",
    };
  }

  if (input.dbRecord) {
    // 锁被删了但库里有记录：这是「未授权删除安装锁」的典型特征。
    try {
      writeLock(dir, {
        projectId: input.projectId,
        projectVersion: input.dbRecord.projectVersion,
        installerVersion: INSTALLER_VERSION,
        installedAt: input.dbRecord.installedAt,
        recordId: null,
        adopted: true,
      });
    } catch {
      /* 写不进去也不能因此允许重装 */
    }
    return {
      ...base,
      state: "INSTALLED",
      source: "database",
      installedAt: input.dbRecord.installedAt,
      projectVersion: input.dbRecord.projectVersion,
      tampered: true,
      adopted: false,
      reason: "数据库存在安装记录但本地安装锁缺失（疑似被删除），已重建锁并锁定安装入口",
    };
  }

  /*
   * 自己的安装过程留下的数据，不能当成「别人的既有安装」。
   *
   * 场景：第一次安装跑到 initialize 步骤失败，库里已经有 42 张表和 1 个组织。
   * 如果这里直接走下面的 adopted 分支，状态会变成 INSTALLED 并被锁死，
   * 用户永远无法「继续安装」——而规格明确要求支持安装失败恢复。
   * 判据是本地状态文件：INSTALLING / FAILED / RECOVERY 说明这次安装是我们自己发起的、
   * 还没走完，应当按原状态返回，让恢复流程接管。
   */
  if (inFlightState && storedState) {
    return {
      ...base,
      state: inFlightState,
      source: "default",
      installedAt: storedState.installedAt,
      tampered: false,
      adopted: false,
      reason: storedState.reason ?? "上一次安装未完成，可继续",
    };
  }

  if (input.probe === undefined || input.probe === null) {
    return {
      ...base,
      state: "UNKNOWN",
      source: "probe",
      tampered: false,
      adopted: false,
      reason: "数据库当前不可连接，无法判断是否已安装；为防止覆盖既有数据，安装入口已锁定",
    };
  }

  if (input.probe.installed) {
    try {
      writeLock(dir, {
        projectId: input.projectId,
        projectVersion: input.projectVersion ?? "unknown",
        installerVersion: INSTALLER_VERSION,
        installedAt: new Date().toISOString(),
        recordId: null,
        adopted: true,
      });
    } catch {
      /* 见上 */
    }
    return {
      ...base,
      state: "INSTALLED",
      source: "adopted",
      installedAt: new Date().toISOString(),
      tampered: false,
      adopted: true,
      reason: `检测到项目已有数据（${input.probe.evidence.join("；")}），按已安装处理并自动写入安装锁`,
    };
  }

  const stored = storedState;
  const state: InstallState = stored?.state ?? "UNINSTALLED";
  return {
    ...base,
    state,
    source: "default",
    installedAt: stored?.installedAt,
    tampered: false,
    adopted: false,
    reason: stored?.reason ?? "未检测到安装痕迹",
  };
}

/** 仅供测试与排障：清掉一个项目的全部安装器状态。 */
export function resetProjectState(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export type { StateSource };
