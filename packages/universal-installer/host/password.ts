/**
 * 口令哈希与口令策略（宿主口径的副本）
 *
 * 来源：Authorization-Management（原仓本文件 src/lib/auth/password.ts）@ 提交 d38c077（阶段 3 拆分时抄录）。
 * 这是**逐字复制**，不是重新实现：安装器要创建管理员账号、写角色与权限，
 * 必须与宿主项目口径完全一致（scrypt 参数、口令策略、权限码表）。
 * 改动规则：宿主侧改了这里就要跟着改，两边内容必须保持一致；构建期没有联动检查。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * 密码哈希：scrypt（Node 内置，无第三方依赖）。
 * 存储格式：scrypt$N$r$p$saltBase64$hashBase64，便于以后升级参数。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** 密码强度基线：长度 ≥ 10，且包含字母与数字。 */
export function passwordPolicyIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 10) issues.push("密码长度至少 10 位");
  if (!/[a-zA-Z]/.test(password)) issues.push("密码必须包含字母");
  if (!/[0-9]/.test(password)) issues.push("密码必须包含数字");
  return issues;
}
