import type { NextRequest } from "next/server";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError } from "@/lib/http/api";
import { queryLicenses } from "@/lib/services/license-list";
import { writeAudit } from "@/lib/domain/audit";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 导出当前筛选结果（规格 15.6）。
 * 安全约定：只导出脱敏兑换码（••••-XXXX），导出动作本身写审计。
 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "license:read", async ({ session, requestId, ip, userAgent }) => {
    const url = new URL(req.url);
    const exportable = session.permissions.has("license:read");
    if (!exportable) throw new ApiError(403, "FORBIDDEN", "缺少导出权限");

    const filters = {
      q: url.searchParams.get("q") ?? "",
      sort: url.searchParams.get("sort"),
      order: (url.searchParams.get("order") === "asc" ? "asc" : "desc") as "asc" | "desc",
      productId: url.searchParams.get("productId") ?? undefined,
      customerId: url.searchParams.get("customerId") ?? undefined,
      adminStatus: url.searchParams.getAll("adminStatus"),
      effectiveStatus: url.searchParams.get("effectiveStatus") ?? undefined,
      expiringInDays: Number(url.searchParams.get("expiringInDays") ?? 0) || undefined,
    };

    const collected: Awaited<ReturnType<typeof queryLicenses>>["items"] = [];
    const pageSize = 200;
    let page = 1;
    let pageCount = 1;
    do {
      const result = await queryLicenses(session.organization.id, {
        ...filters,
        page,
        pageSize,
      });
      collected.push(...result.items);
      pageCount = result.pageCount;
      page += 1;
    } while (page <= pageCount && collected.length < 5000);

    const header = [
      "license_id",
      "product",
      "customer",
      "admin_status",
      "effective_status",
      "duration_unit",
      "duration_value",
      "starts_at",
      "expires_at",
      "max_devices",
      "active_devices",
      "activation_count",
      "max_activation_count",
      "key_mask",
      "created_at",
    ];
    const lines = collected.map((row) =>
      [
        row.id,
        row.product.name,
        row.customer.name,
        row.adminStatus,
        row.effective.status,
        row.duration.unit,
        row.duration.value,
        row.startsAt,
        row.expiresAt,
        row.maxDevices,
        row.activeDevices,
        row.activationCount,
        row.maxActivationCount,
        row.keyMask,
        row.createdAt,
      ]
        .map(csvCell)
        .join(","),
    );
    const csv = "\ufeff" + [header.join(","), ...lines].join("\n");

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "license.export",
      resourceType: "license",
      resourceId: null,
      after: { rows: collected.length, filters },
      requestId,
      ip,
      userAgent,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="licenses-${new Date().toISOString().slice(0, 10)}.csv"`,
        "x-request-id": requestId,
        "cache-control": "no-store",
      },
    });
  });
}
