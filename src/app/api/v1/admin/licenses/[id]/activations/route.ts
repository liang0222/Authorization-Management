import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readListQuery } from "@/lib/http/api";

/** 单份授权的设备列表（规格 4.5 GET /admin/licenses/{id}/activations）。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "activation:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const license = await prisma.licenses.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, max_devices: true, activation_count: true, max_activation_count: true },
    });
    if (!license) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");

    const query = readListQuery(new URL(req.url));
    const where = { license_id: id, organization_id: session.organization.id };
    const [rows, total, activeCount] = await Promise.all([
      prisma.activations.findMany({
        where,
        include: { devices: true },
        orderBy: { activated_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
      }),
      prisma.activations.count({ where }),
      prisma.activations.count({ where: { ...where, status: "active" } }),
    ]);

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          status: row.status,
          deviceName: row.devices.device_name,
          platform: row.devices.platform,
          instanceId: row.devices.device_instance_id,
          clientVersion: row.client_version,
          activatedAt: row.activated_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          releasedAt: row.released_at?.toISOString() ?? null,
          lastIp: row.last_ip,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
        quota: {
          maxDevices: license.max_devices,
          activeDevices: activeCount,
          activationCount: license.activation_count,
          maxActivationCount: license.max_activation_count,
        },
      },
      requestId,
    );
  });
}
