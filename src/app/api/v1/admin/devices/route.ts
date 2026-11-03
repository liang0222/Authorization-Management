import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, okResponse, readListQuery, parseSort } from "@/lib/http/api";

/**
 * 激活设备（跨授权）列表。
 * 数据源是 activations（绑定行为），不是 devices（设备档案）——
 * 同一台设备解绑后重新激活会产生新的激活记录，历史必须保留。
 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "activation:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const platform = url.searchParams.get("platform");
    const status = url.searchParams.get("status");
    const productId = url.searchParams.get("productId");
    const online = url.searchParams.get("online") === "1";
    const licenseId = url.searchParams.get("licenseId");
    const sortKey = parseSort(query.sort, ["last_seen_at", "activated_at"] as const, "last_seen_at");

    const where = {
      organization_id: session.organization.id,
      ...(status && ["active", "released", "revoked", "blocked"].includes(status)
        ? { status: status as "active" | "released" | "revoked" | "blocked" }
        : {}),
      ...(productId ? { product_id: productId } : {}),
      ...(licenseId ? { license_id: licenseId } : {}),
      ...(platform ? { devices: { platform } } : {}),
      ...(online
        ? { status: "active" as const, last_seen_at: { gte: new Date(Date.now() - 30 * 60_000) } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { devices: { device_name: { contains: query.q, mode: "insensitive" as const } } },
              { devices: { device_instance_id: { contains: query.q, mode: "insensitive" as const } } },
              { licenses: { customers: { name: { contains: query.q, mode: "insensitive" as const } } } },
              { licenses: { customers: { email: { contains: query.q, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };

    const [rows, total, counts] = await Promise.all([
      prisma.activations.findMany({
        where,
        orderBy: { [sortKey]: query.order },
        skip: query.skip,
        take: query.pageSize,
        include: {
          devices: true,
          licenses: { include: { customers: { select: { id: true, name: true } } } },
          products: { select: { id: true, name: true, code: true } },
        },
      }),
      prisma.activations.count({ where }),
      prisma.activations.groupBy({
        by: ["status"],
        where: { organization_id: session.organization.id },
        _count: { _all: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(counts.map((row) => [row.status, row._count._all]));
    const onlineCount = await prisma.activations.count({
      where: {
        organization_id: session.organization.id,
        status: "active",
        last_seen_at: { gte: new Date(Date.now() - 30 * 60_000) },
      },
    });

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          status: row.status,
          device: {
            id: row.devices.id,
            name: row.devices.device_name,
            instanceId: row.devices.device_instance_id,
            platform: row.devices.platform,
            fingerprint: row.devices.public_key_thumbprint,
            firstSeenAt: row.devices.first_seen_at.toISOString(),
          },
          license: {
            id: row.licenses.id,
            adminStatus: row.licenses.admin_status,
            customerName: row.licenses.customers.name,
            customerId: row.licenses.customers.id,
          },
          product: row.products,
          activatedAt: row.activated_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          releasedAt: row.released_at?.toISOString() ?? null,
          clientVersion: row.client_version,
          lastIp: row.last_ip,
          online: row.status === "active" && row.last_seen_at.getTime() > Date.now() - 30 * 60_000,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
        summary: {
          byStatus: statusCounts,
          online: onlineCount,
        },
      },
      requestId,
    );
  });
}
