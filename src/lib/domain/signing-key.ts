import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api";
import { config } from "@/lib/config";

/**
 * Ed25519 签名密钥的读取与签名（规格 6.4 / 13.9 / 4.13）。
 *
 * 为什么单独一个模块：离线授权文件（`/offline-grants`）和服务端令牌（`/oauth/token`）
 * 都要用同一套密钥签名，而管理路由里只管生成与轮换。签名逻辑集中在这里，
 * 保证「同一份 payload 在任何端点都算出同一串字节」。
 *
 * 格式约定（与库中既有 `signing_keys.public_key` 一致）：
 * - 公钥存**整段 SPKI DER**（44 字节 = 12 字节头 + 32 字节原始公钥），
 *   调用方可以直接 `createPublicKey({ key, format: "der", type: "spki" })` 验签；
 *   需要 raw 32 字节的客户端取 DER 的后 32 字节。
 * - 私钥只以 PEM 文件存在于服务器本地目录（0600），数据库只存文件名。
 */

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_LENGTH = 32;

export interface ActiveSigningKey {
  id: string;
  kid: string;
  /** SPKI DER，44 字节。 */
  publicKeyDer: Buffer;
  /** raw 32 字节公钥，给只支持裸密钥的平台用。 */
  rawPublicKey: Buffer;
  notBefore: Date;
  notAfter: Date | null;
}

function privateKeyPath(privateKeyRef: string): string {
  // private_key_ref 只存文件名；目录来自配置，任何人都不能通过库里的值跳出目录。
  return resolve(join(resolve(process.cwd(), config.signingKeyDir), basename(privateKeyRef)));
}

function toActiveKey(row: {
  id: string;
  kid: string;
  public_key: Uint8Array;
  not_before: Date;
  not_after: Date | null;
}): ActiveSigningKey {
  const der = Buffer.from(row.public_key);
  if (der.length !== SPKI_PREFIX.length + RAW_KEY_LENGTH) {
    throw new ApiError(
      500,
      "SIGNING_KEY_INVALID",
      "签名公钥不是标准的 Ed25519 SPKI DER（应为 44 字节）",
      { kid: row.kid, length: der.length },
    );
  }
  return {
    id: row.id,
    kid: row.kid,
    publicKeyDer: der,
    rawPublicKey: der.subarray(der.length - RAW_KEY_LENGTH),
    notBefore: row.not_before,
    notAfter: row.not_after,
  };
}

/**
 * 取当前可用的签名密钥。
 *
 * 优先级：产品专属密钥 > 组织级密钥（`product_id` 为空）；同一层级取 `created_at` 最新。
 * 只认 `status = "active"` 且时间窗有效的行 —— staged 还没启用，retiring 只用于验旧签名，
 * 都不能拿来签新东西。
 */
export async function loadActiveSigningKey(
  organizationId: string,
  productId?: string | null,
): Promise<ActiveSigningKey> {
  const now = new Date();
  const rows = await prisma.signing_keys.findMany({
    where: {
      organization_id: organizationId,
      status: "active",
      not_before: { lte: now },
      // 两个 OR 必须分开写进 AND 数组：同一个对象字面量里出现两次 `OR` 键，
      // 后者会静默覆盖前者（时间窗约束就丢了）。
      AND: [
        { OR: [{ not_after: null }, { not_after: { gt: now } }] },
        ...(productId ? [{ OR: [{ product_id: productId }, { product_id: null }] }] : []),
      ],
    },
    orderBy: { created_at: "desc" },
    select: { id: true, kid: true, public_key: true, not_before: true, not_after: true, product_id: true },
  });
  if (rows.length === 0) {
    throw new ApiError(
      503,
      "LICENSE_SERVICE_UNAVAILABLE",
      "该组织还没有可用的签名密钥，请先在「签名密钥」页生成并启用一把",
    );
  }
  // 产品专属优先：同一批里挑 product_id 命中的第一条。
  const preferred = rows.find((row) => row.product_id === productId) ?? rows[0];
  return toActiveKey(preferred);
}

/** 读出私钥对象；私钥文件缺失属于运维事故，直接报 503 而不是 500。 */
export function loadPrivateKey(privateKeyRef: string): KeyObject {
  const path = privateKeyPath(privateKeyRef);
  let pem: Buffer;
  try {
    pem = readFileSync(path);
  } catch {
    throw new ApiError(503, "LICENSE_SERVICE_UNAVAILABLE", "签名私钥文件不可读，请检查密钥目录挂载", {
      ref: basename(privateKeyRef),
    });
  }
  try {
    return createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new ApiError(503, "LICENSE_SERVICE_UNAVAILABLE", "签名私钥格式错误，应为 PKCS#8 Ed25519 PEM");
  }
}

/** 用私钥对任意字节签名（Ed25519，返回 64 字节）。 */
export function signBytes(privateKey: KeyObject, payload: Buffer): Buffer {
  return cryptoSign(null, payload, privateKey);
}

/**
 * 规范化 JSON（规格 4.13「签名覆盖规范化、确定性序列化后的 payload」）。
 *
 * 规则：对象键按 UTF-16 code unit 升序；数组保持顺序；无多余空白；不写出 undefined。
 * 这样无论服务端用哪个 JSON 库、字段插入顺序如何，同一份数据都得到同一串字节，
 * 客户端才能自己重算哈希做离线验签。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = sortValue(item);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/** `sha256:<base64url>` 形式的设备公钥指纹（规格 4.13 的 device_key_thumbprint）。 */
export function deviceKeyThumbprint(publicKeyBase64Url: string): string {
  const bytes = Buffer.from(publicKeyBase64Url, "base64url");
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
}

/** 把 raw 32 字节公钥包成 SPKI DER，便于客户端按标准格式导入。 */
export function rawToSpkiDer(raw: Buffer): Buffer {
  if (raw.length !== RAW_KEY_LENGTH) {
    throw new ApiError(400, "INVALID_REQUEST", "Ed25519 公钥必须是 32 字节");
  }
  return Buffer.concat([SPKI_PREFIX, raw]);
}

/** SPKI DER 转回 raw 32 字节。 */
export function spkiDerToRaw(der: Buffer): Buffer {
  if (der.length < RAW_KEY_LENGTH) {
    throw new ApiError(400, "INVALID_REQUEST", "Ed25519 SPKI DER 长度不足");
  }
  return der.subarray(der.length - RAW_KEY_LENGTH);
}

/** 校验一段 DER 能否被 Node 解析为 Ed25519 公钥（用于自检与测试）。 */
export function assertEd25519PublicKey(der: Buffer): void {
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ApiError(500, "SIGNING_KEY_INVALID", "公钥不是 Ed25519");
  }
}