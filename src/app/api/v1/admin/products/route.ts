import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const productSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "产品编码至少 2 个字符")
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "编码只能包含小写字母、数字、- 和 _"),
  name: z.string().trim().min(2, "产品名称至少 2 个字符").max(160),
  description: z.string().max(2000).nullish(),
  productType: z.enum(["desktop", "browser_extension", "mini_program", "web", "server", "other"]),
  currentVersion: z.string().max(80).nullish(),
  supportedPlatforms: z.array(z.string().max(40)).max(10).optional(),
  heartbeatIntervalSeconds: z.number().int().min(60).max(86400).optional(),
  accessTokenTtlSeconds: z.number().int().min(60).max(3600).optional(),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "product:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url, 12);
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("productType");

    const where = {
      organization_id: session.organization.id,
      ...(status && ["active", "disabled", "archived"].includes(status)
        ? { status: status as "active" | "disabled" | "archived" }
        : {}),
      ...(type ? { product_type: type as never } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { code: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.products.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        include: {
          _count: { select: { product_features: true, licenses: true, product_credentials: true } },
        },
      }),
      prisma.products.count({ where }),
    ]);

    const activeDevices = await prisma.activations.groupBy({
      by: ["product_id"],
      where: {
        organization_id: session.organization.id,
        status: "active",
        product_id: { in: rows.map((row) => row.id) },
      },
      _count: { _all: true },
    });
    const deviceMap = new Map(activeDevices.map((row) => [row.product_id, row._count._all]));

    const plansPerProduct = await prisma.plans.groupBy({
      by: ["product_id"],
      where: { organization_id: session.organization.id, product_id: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    const planMap = new Map(plansPerProduct.map((row) => [row.product_id, row._count._all]));

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          type: row.product_type,
          status: row.status,
          currentVersion: row.current_version,
          supportedPlatforms: row.supported_platforms,
          heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
          accessTokenTtlSeconds: row.access_token_ttl_seconds,
          createdAt: row.created_at.toISOString(),
          counts: {
            features: row._count.product_features,
            licenses: row._count.licenses,
            credentials: row._count.product_credentials,
            plans: planMap.get(row.id) ?? 0,
            activeDevices: deviceMap.get(row.id) ?? 0,
          },
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
      },
      requestId,
    );
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "product:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, productSchema);
    try {
      const product = await prisma.products.create({
        data: {
          organization_id: session.organization.id,
          code: body.code,
          name: body.name,
          description: body.description ?? null,
          product_type: body.productType,
          current_version: body.currentVersion ?? null,
          supported_platforms: body.supportedPlatforms ?? [],
          heartbeat_interval_seconds: body.heartbeatIntervalSeconds ?? 900,
          access_token_ttl_seconds: body.accessTokenTtlSeconds ?? 600,
        },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "product.create",
        resourceType: "product",
        resourceId: product.id,
        after: { code: product.code, name: product.name, type: product.product_type },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ id: product.id }, requestId, { status: 201 });
    } catch (error) {
      translatePrismaError(error, "该产品编码已被占用");
    }
  });
}
