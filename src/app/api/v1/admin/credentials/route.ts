import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, pageResult, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { generateClientId, generateClientSecret } from "@/lib/domain/license-key";

/**
 * 产品凭证（规格 4.5 / 6.1）：
 * - client_id 是标识，可以出现在客户端；secret 只允许出现在“创建/轮换”的响应里一次。
 * - 机密服务端凭证的 secret 只保存 SHA-256 摘要；公开客户端按数据库 CHECK 约束 secret_hash 必须为 NULL。
 */

/** 作用域白名单：任何未列出的字符串都会被拒绝，避免把不存在的权限写进凭证。 */
const CREDENTIAL_SCOPES = [
  "license:validate",
  "activation:create",
  "activation:heartbeat",
  "activation:deactivate",
  "entitlements:read",
  "offline:grant",
  "server:check",
  "server:assign",
] as const;

const CREDENTIAL_TYPES = ["public_client", "confidential_server"] as const;
const RECORD_STATUSES = ["active", "disabled", "archived"] as const;

const createSchema = z.object({
  name: z.string().trim().min(1, "请填写凭证名称").max(120),
  productId: z.string().uuid("请选择产品"),
  type: z.enum(CREDENTIAL_TYPES),
  scopes: z.array(z.enum(CREDENTIAL_SCOPES)).max(CREDENTIAL_SCOPES.length).default([]),
  allowedOrigins: z
    .array(z.string().trim().url("来源地址必须是合法 URL").max(500))
    .max(20)
    .default([]),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "credential:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const productId = url.searchParams.get("productId");
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");
    const where = {
      organization_id: session.organization.id,
      // 环境隔离（规格 27.3）：列表只展示本进程环境的凭证。
      environment: config.credentialEnvironment,
      ...(productId ? { product_id: productId } : {}),
      ...(type && (CREDENTIAL_TYPES as readonly string[]).includes(type)
        ? { credential_type: type as (typeof CREDENTIAL_TYPES)[number] }
        : {}),
      ...(status && (RECORD_STATUSES as readonly string[]).includes(status)
        ? { status: status as (typeof RECORD_STATUSES)[number] }
        : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { client_id: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.product_credentials.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          credential_type: true,
          client_id: true,
          // 仅为计算 hasSecret 而读取；下面逐字段映射，secret_hash 不会进入响应体。
          secret_hash: true,
          scopes: true,
          allowed_origins: true,
          status: true,
          environment: true,
          expires_at: true,
          last_used_at: true,
          created_at: true,
          rotated_at: true,
          product_id: true,
          products: { select: { id: true, name: true, code: true } },
        },
      }),
      prisma.product_credentials.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.credential_type,
      clientId: row.client_id,
      status: row.status,
      /** 凭证所属环境；沙箱实例只可能看到 sandbox。 */
      environment: row.environment,
      /** 是否配置了密钥；具体摘要不出库、不出接口。 */
      hasSecret: row.secret_hash !== null,
      scopes: row.scopes,
      allowedOrigins: row.allowed_origins,
      productId: row.product_id,
      product: row.products,
      expiresAt: row.expires_at?.toISOString() ?? null,
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      rotatedAt: row.rotated_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    }));

    return okResponse(pageResult(items, total, query), requestId);
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "credential:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, createSchema);

    // 公开客户端运行在浏览器/小程序等不可信环境，按规格不登记来源白名单，避免把 CORS 白名单误配到公开客户端。
    if (body.type === "public_client" && body.allowedOrigins.length > 0) {
      throw new ApiError(400, "INVALID_REQUEST", "公开客户端凭证不能配置允许来源");
    }

    const product = await prisma.products.findFirst({
      where: { id: body.productId, organization_id: session.organization.id },
      select: { id: true, name: true },
    });
    if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");

    const clientId = generateClientId(body.type);
    // 只有机密服务端凭证持有 secret；它的明文仅在本次响应出现，数据库只落 SHA-256。
    const clientSecret = body.type === "confidential_server" ? generateClientSecret() : null;
    const secretHash = clientSecret ? createHash("sha256").update(clientSecret).digest() : null;

    try {
      const created = await prisma.product_credentials.create({
        data: {
          organization_id: session.organization.id,
          product_id: body.productId,
          name: body.name,
          credential_type: body.type,
          client_id: clientId,
          secret_hash: secretHash,
          scopes: [...body.scopes],
          allowed_origins: body.type === "public_client" ? [] : [...body.allowedOrigins],
          status: "active",
          // 在哪个环境里创建就属于哪个环境，不允许管理端跨环境写凭证。
          environment: config.credentialEnvironment,
        },
      });

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "credential.create",
        resourceType: "credential",
        resourceId: created.id,
        after: {
          product: product.name,
          name: created.name,
          clientId: created.client_id,
          type: created.credential_type,
          scopes: created.scopes,
          allowedOrigins: created.allowed_origins,
        },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          id: created.id,
          name: created.name,
          type: created.credential_type,
          clientId: created.client_id,
          // 一次性返回：之后任何接口（含列表）都不会再返回 secret。
          clientSecret,
          scopes: created.scopes,
          allowedOrigins: created.allowed_origins,
          status: created.status,
          createdAt: created.created_at.toISOString(),
          secretNotice: clientSecret
            ? "clientSecret 仅显示一次，请立即保存到服务端密钥管理，丢失后只能轮换"
            : "公开客户端凭证不持有密钥",
        },
        requestId,
        { status: 201 },
      );
    } catch (error) {
      translatePrismaError(error, "凭证标识冲突，请重试");
    }
  });
}
