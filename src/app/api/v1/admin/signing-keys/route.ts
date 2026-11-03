import type { NextRequest } from "next/server";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, pageResult, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { config } from "@/lib/config";

/**
 * Ed25519 签名密钥（规格 6.4 / 13.9）。
 *
 * 安全边界：
 * - 私钥只写入服务器本地受控目录（权限 0600），数据库只存相对文件名 `private_key_ref`。
 * - 任何接口都不返回私钥内容；列表里的 privateKeyRef 只保留文件名，去掉目录结构。
 * - public_key 存整段 Ed25519 SPKI DER（44 字节 = 12 字节头 + 32 字节原始公钥），
 *   与库中既有密钥行保持同一格式，调用方可以直接
 *   `crypto.createPublicKey({ key, format: "der", type: "spki" })` 验签；
 *   需要 raw key 的客户端取 DER 的后 32 字节即可。若以后要改成只存 raw 32 字节，
 *   必须同步迁移历史行并更新所有验签方，否则同一列会出现两种编码。
 */

const SIGNING_KEY_STATUSES = ["staged", "active", "retiring", "revoked"] as const;

/** Ed25519 SPKI DER：30 2a 30 05 06 03 2b 65 70 03 21 00 || 32 字节公钥。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_KEY_LENGTH = 32;

const createSchema = z.object({
  productId: z.string().uuid("请选择产品").nullish(),
  notAfter: z.string().trim().min(1).max(40).nullish(),
});

/** 公钥指纹：sha256(public_key) 的前 16 字节 hex，用于人工比对“同一把密钥”。 */
function publicKeyFingerprint(publicKey: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(publicKey)).digest().subarray(0, 16).toString("hex");
}

/** kid：sk_yyyyMMdd_randomhex（UTC 日期 + 64 bit 随机后缀，天然唯一且可读）。 */
function formatKid(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `sk_${yyyy}${mm}${dd}_${randomBytes(8).toString("hex")}`;
}

/** 只返回相对文件名，避免把服务器绝对路径/目录结构暴露给前端。 */
function relativeKeyRef(privateKeyRef: string): string {
  return basename(privateKeyRef);
}

export async function GET(req: NextRequest) {
  return withAdmin(req, "signingkey:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const productId = url.searchParams.get("productId");
    const status = url.searchParams.get("status");
    const where = {
      organization_id: session.organization.id,
      ...(productId ? { product_id: productId } : {}),
      ...(status && (SIGNING_KEY_STATUSES as readonly string[]).includes(status)
        ? { status: status as (typeof SIGNING_KEY_STATUSES)[number] }
        : {}),
      ...(query.q ? { kid: { contains: query.q, mode: "insensitive" as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.signing_keys.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        include: { products: { select: { id: true, name: true, code: true } } },
      }),
      prisma.signing_keys.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      kid: row.kid,
      algorithm: row.algorithm,
      status: row.status,
      productId: row.product_id,
      product: row.products,
      notBefore: row.not_before.toISOString(),
      notAfter: row.not_after?.toISOString() ?? null,
      /** 公钥可以公开，返回指纹供运维核对；不返回私钥的任何片段。 */
      publicKeyFingerprint: publicKeyFingerprint(row.public_key),
      privateKeyRef: relativeKeyRef(row.private_key_ref),
      createdAt: row.created_at.toISOString(),
    }));

    return okResponse(pageResult(items, total, query), requestId);
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "signingkey:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, createSchema);

    if (body.productId) {
      const product = await prisma.products.findFirst({
        where: { id: body.productId, organization_id: session.organization.id },
        select: { id: true },
      });
      if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");
    }

    const now = new Date();
    let notAfter: Date | null = null;
    if (body.notAfter) {
      notAfter = new Date(body.notAfter);
      if (Number.isNaN(notAfter.getTime())) {
        throw new ApiError(400, "INVALID_REQUEST", "notAfter 必须是合法的 ISO 时间");
      }
      // 数据库 CHECK(not_after > not_before) 在 SQL 层也会拦，这里提前给出可读错误。
      if (notAfter.getTime() <= now.getTime()) {
        throw new ApiError(400, "INVALID_REQUEST", "notAfter 必须晚于当前时间");
      }
    }

    const kid = formatKid(now);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    if (
      spkiDer.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH ||
      !spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      // 结构不符说明运行时导出的不是预期的 Ed25519 SPKI，宁可失败也不要写入不可用的公钥。
      throw new ApiError(500, "INTERNAL_ERROR", "公钥导出格式异常，已中止密钥生成");
    }
    // 整段 SPKI DER 入库（copy 成独立 Uint8Array：Buffer.subarray 只是视图，且 Buffer 类型与 Prisma Bytes 不兼容）。
    const publicKeyDer = Uint8Array.from(spkiDer);

    // 私钥落盘：目录不存在则创建（0700），文件独占创建并显式收紧到 0600。
    const keyDir = resolve(process.cwd(), config.signingKeyDir);
    const fileName = `${kid}.pem`;
    const keyPath = join(keyDir, fileName);
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    try {
      mkdirSync(keyDir, { recursive: true, mode: 0o700 });
      writeFileSync(keyPath, pem, { mode: 0o600, flag: "wx" });
      chmodSync(keyPath, 0o600);
    } catch (error) {
      // 不把服务器绝对路径回给调用方，只给出可操作的提示。
      console.error("[signing-key] 私钥写入失败", { kid, error });
      throw new ApiError(500, "INTERNAL_ERROR", "签名私钥写入失败，请检查密钥目录权限");
    }

    try {
      const created = await prisma.signing_keys.create({
        data: {
          organization_id: session.organization.id,
          product_id: body.productId ?? null,
          kid,
          algorithm: "EdDSA",
          public_key: publicKeyDer,
          private_key_ref: fileName,
          // 新建即可签发；轮换仍按 staged → active → retiring → revoked 的状态机走 PATCH。
          status: "active",
          not_before: now,
          not_after: notAfter,
        },
      });

      const fingerprint = publicKeyFingerprint(publicKeyDer);
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "signingkey.create",
        resourceType: "signing_key",
        resourceId: created.id,
        // 审计只记录非敏感标识：kid、算法、公钥指纹，绝不含私钥或私钥路径细节。
        after: {
          kid: created.kid,
          algorithm: created.algorithm,
          status: created.status,
          productId: created.product_id,
          publicKeyFingerprint: fingerprint,
        },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          id: created.id,
          kid: created.kid,
          algorithm: created.algorithm,
          status: created.status,
          productId: created.product_id,
          // 公钥可公开：base64 的 SPKI DER（44 字节），附编码说明避免调用方误当 raw key。
          publicKey: Buffer.from(publicKeyDer).toString("base64"),
          publicKeyEncoding: "spki-der",
          /** DER 头 12 字节之后的 32 字节即 Ed25519 raw 公钥，供只需要 raw key 的客户端使用。 */
          publicKeyRaw: Buffer.from(publicKeyDer.subarray(ED25519_SPKI_PREFIX.length)).toString("base64"),
          publicKeyFingerprint: fingerprint,
          privateKeyRef: fileName,
          notBefore: created.not_before.toISOString(),
          notAfter: created.not_after?.toISOString() ?? null,
          createdAt: created.created_at.toISOString(),
          secretNotice: "私钥已写入服务器密钥目录（0600），不会通过接口返回",
        },
        requestId,
        { status: 201 },
      );
    } catch (error) {
      // 数据库写入失败时删除刚落盘的私钥，避免留下无记录归属的密钥文件。
      try {
        unlinkSync(keyPath);
      } catch {
        // 清理失败不掩盖原始错误；运维可通过 kid 前缀定位残留文件。
      }
      translatePrismaError(error, "签名密钥标识冲突，请重试");
    }
  });
}
