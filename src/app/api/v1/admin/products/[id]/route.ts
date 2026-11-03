import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const patchSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().max(2000).nullish(),
  status: z.enum(["active", "disabled", "archived"]).optional(),
  currentVersion: z.string().max(80).nullish(),
  supportedPlatforms: z.array(z.string().max(40)).max(10).optional(),
  heartbeatIntervalSeconds: z.number().int().min(60).max(86400).optional(),
  accessTokenTtlSeconds: z.number().int().min(60).max(3600).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "product:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const product = await prisma.products.findFirst({
      where: { id, organization_id: session.organization.id },
      include: {
        product_features: { orderBy: { created_at: "asc" } },
        product_credentials: {
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            name: true,
            credential_type: true,
            client_id: true,
            status: true,
            scopes: true,
            allowed_origins: true,
            last_used_at: true,
            created_at: true,
          },
        },
        plans: { orderBy: { created_at: "desc" } },
        _count: { select: { licenses: true, webhook_endpoints: true, signing_keys: true } },
      },
    });
    if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在或不属于当前组织");

    const [activeDevices, licenseStats] = await Promise.all([
      prisma.activations.count({
        where: { organization_id: session.organization.id, product_id: id, status: "active" },
      }),
      prisma.licenses.groupBy({
        by: ["admin_status"],
        where: { organization_id: session.organization.id, product_id: id, deleted_at: null },
        _count: { _all: true },
      }),
    ]);

    return okResponse(
      {
        product: {
          id: product.id,
          code: product.code,
          name: product.name,
          description: product.description,
          type: product.product_type,
          status: product.status,
          currentVersion: product.current_version,
          supportedPlatforms: product.supported_platforms,
          heartbeatIntervalSeconds: product.heartbeat_interval_seconds,
          accessTokenTtlSeconds: product.access_token_ttl_seconds,
          policy: product.policy,
          createdAt: product.created_at.toISOString(),
          updatedAt: product.updated_at.toISOString(),
        },
        features: product.product_features.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          valueType: row.value_type,
          defaultValue: row.default_value,
          status: row.status,
          createdAt: row.created_at.toISOString(),
        })),
        credentials: product.product_credentials.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.credential_type,
          clientId: row.client_id,
          status: row.status,
          scopes: row.scopes,
          allowedOrigins: row.allowed_origins,
          lastUsedAt: row.last_used_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
        plans: product.plans.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          durationUnit: row.duration_unit,
          durationValue: row.duration_value,
          maxDevices: row.max_devices,
          status: row.status,
        })),
        counts: {
          activeDevices,
          licenses: product._count.licenses,
          webhooks: product._count.webhook_endpoints,
          signingKeys: product._count.signing_keys,
          licenseByStatus: Object.fromEntries(licenseStats.map((row) => [row.admin_status, row._count._all])),
        },
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "product:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);
    const before = await prisma.products.findFirst({
      where: { id, organization_id: session.organization.id },
    });
    if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");
    try {
      const updated = await prisma.products.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description === undefined ? undefined : body.description,
          status: body.status,
          current_version: body.currentVersion === undefined ? undefined : body.currentVersion,
          supported_platforms: body.supportedPlatforms,
          heartbeat_interval_seconds: body.heartbeatIntervalSeconds,
          access_token_ttl_seconds: body.accessTokenTtlSeconds,
          updated_at: new Date(),
        },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: body.status && body.status !== before.status ? "product.status_change" : "product.update",
        resourceType: "product",
        resourceId: id,
        before: { name: before.name, status: before.status },
        after: { name: updated.name, status: updated.status },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ updated: true }, requestId);
    } catch (error) {
      translatePrismaError(error, "产品更新失败");
    }
  });
}
