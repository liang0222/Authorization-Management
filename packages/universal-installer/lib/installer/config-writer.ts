/**
 * 运行配置落盘（规格 §五 第 14 步、§六 安全要求）。
 *
 * 本项目（Next.js）的配置形态是 systemd 的 EnvironmentFile，所以安装器直接
 * 生成一个 0600 的 env 文件，而不是改源码里的常量。
 *
 * 硬性要求：
 * - 目录 0755、文件 0600（systemd 以 root 读，其他用户不可读）。
 * - 写入用临时文件 + fsync + rename，中途断电不会留下半截配置。
 * - 覆盖前先备份成 `<file>.bak-<时间戳>`，配置回滚有据可依。
 * - 返回给调用方的摘要里绝不包含秘密值（只给 key 名与是否新生成）。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWrite, redact } from "./store";

export interface ConfigWriteRequest {
  /** 目标 env 文件绝对路径。 */
  path: string;
  /** 由表单与适配器共同决定的键值。秘密已经在里面。 */
  values: Record<string, string>;
  /** 覆盖前备份。默认 true。 */
  backup?: boolean;
}

export interface ConfigWriteResult {
  path: string;
  /** 只含键名，不含值。 */
  keys: string[];
  /** 本次新生成的秘密键名（用于提示用户「这些是安装器生成的，请另行备份」）。 */
  generated: string[];
  backupPath?: string;
  bytes: number;
}

/** systemd EnvironmentFile 的键名规则。导出供测试与文档共用。 */
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** 生成 32 字节 base64url 随机值，用于会话密钥、HMAC pepper 等。 */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function formatValue(value: string): string {
  // systemd 的 EnvironmentFile 对空格和引号敏感：有特殊字符就整体加双引号并转义。
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderEnvFile(values: Record<string, string>): string {
  const lines: string[] = [
    "# 由 Universal Installer 生成。手工修改后请重启服务使其生效。",
    `# 生成时间：${new Date().toISOString()}`,
    "",
  ];
  for (const key of Object.keys(values).sort()) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`非法的环境变量名：${key}`);
    }
    lines.push(`${key}=${formatValue(values[key])}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeRuntimeConfig(request: ConfigWriteRequest): ConfigWriteResult {
  const target = resolve(request.path);
  const values = { ...request.values };

  for (const key of Object.keys(values)) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`非法的环境变量名：${key}`);
    if (values[key] === undefined || values[key] === null) {
      throw new Error(`环境变量 ${key} 的值为空`);
    }
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });

  let backupPath: string | undefined;
  if (request.backup !== false && existsSync(target)) {
    backupPath = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "")}`;
    copyFileSync(target, backupPath);
    chmodSync(backupPath, 0o600);
  }

  const content = renderEnvFile(values);
  atomicWrite(target, content, 0o600);
  chmodSync(target, 0o600);

  return {
    path: target,
    keys: Object.keys(values).sort(),
    generated: [],
    backupPath,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * 读取既有 env 文件并解析成键值（只用于「已存在则保留」的场景）。
 * 解析失败不抛异常——安装器宁可重新生成，也不因为一行怪格式而卡死。
 */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      out[key] = value;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 安装器生成配置时对外展示的摘要，绝不含值。 */
export function summarizeConfig(result: ConfigWriteResult): string {
  return redact(
    `写入 ${result.path}（${result.bytes} 字节，${result.keys.length} 个键）${
      result.backupPath ? `，原文件已备份到 ${result.backupPath}` : ""
    }`,
  );
}

