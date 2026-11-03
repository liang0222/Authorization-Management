import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";

/** 设备档案详情：当前/历史激活记录 + 事件时间线。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "activation:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const device = await prisma.devices.findFirst({
      where: { id, organization_id: session.organization.id },
      include: {
        products: { select: { id: true, name: true, code: true } },
        activations: {
          orderBy: { activated_at: "desc" },
          include: {
            licenses: { include: { customers: { select: { id: true, name: true, email: true } } } },
          },
        },
      },
    });
    if (!device) throw new ApiError(404, "RESOURCE_NOT_FOUND", "设备不存在或不属于当前组织");

    const events = await prisma.activation_events.findMany({
      where: {
        organization_id: session.organization.id,
        activation_id: { in: device.activations.map((row) => row.id) },
      },
      orderBy: { created_at: "desc" },
      take: 50,
    });

    return okResponse(
      {
        device: {
          id: device.id,
          name: device.device_name,
          instanceId: device.device_instance_id,
          platform: device.platform,
          status: device.status,
          publicKeyThumbprint: device.public_key_thumbprint,
          firstSeenAt: device.first_seen_at.toISOString(),
          lastSeenAt: device.last_seen_at?.toISOString() ?? null,
          product: device.products,
          metadata: device.metadata,
        },
        activations: device.activations.map((row) => ({
          id: row.id,
          status: row.status,
          licenseId: row.license_id,
          licenseAdminStatus: row.licenses.admin_status,
          customerName: row.licenses.customers.name,
          activatedAt: row.activated_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          releasedAt: row.released_at?.toISOString() ?? null,
          clientVersion: row.client_version,
          lastIp: row.last_ip,
        })),
        events: events.map((row) => ({
          id: row.id.toString(),
          activationId: row.activation_id,
          type: row.event_type,
          actorType: row.actor_type,
          createdAt: row.created_at.toISOString(),
          details: row.details,
        })),
      },
      requestId,
    );
  });
}
