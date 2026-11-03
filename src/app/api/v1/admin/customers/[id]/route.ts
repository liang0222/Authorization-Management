import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  customerCode: z.string().trim().max(80).nullish(),
  email: z.string().trim().email("邮箱格式不正确").max(254).nullish().or(z.literal("")),
  phone: z.string().trim().max(40).nullish(),
  companyName: z.string().trim().max(160).nullish(),
  notes: z.string().max(2000).nullish(),
  status: z.enum(["active", "disabled", "archived"]).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "customer:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const customer = await prisma.customers.findFirst({
      where: { id, organization_id: session.organization.id },
      include: {
        customer_identities: { orderBy: { created_at: "desc" } },
        licenses: {
          where: { deleted_at: null },
          orderBy: { created_at: "desc" },
          take: 10,
          include: { products: { select: { id: true, name: true } } },
        },
        _count: { select: { licenses: true } },
      },
    });
    if (!customer) throw new ApiError(404, "RESOURCE_NOT_FOUND", "客户不存在或不属于当前组织");

    return okResponse(
      {
        customer: {
          id: customer.id,
          customerCode: customer.customer_code,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          companyName: customer.company_name,
          notes: customer.notes,
          status: customer.status,
          metadata: customer.metadata,
          createdAt: customer.created_at.toISOString(),
          updatedAt: customer.updated_at.toISOString(),
          licenseCount: customer._count.licenses,
        },
        licenses: customer.licenses.map((row) => ({
          id: row.id,
          adminStatus: row.admin_status,
          productName: row.products.name,
          durationUnit: row.duration_unit,
          durationValue: row.duration_value,
          startsAt: row.starts_at?.toISOString() ?? null,
          expiresAt: row.expires_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
        identities: customer.customer_identities.map((row) => ({
          id: row.id,
          provider: row.provider,
          displayName: row.display_name,
          status: row.status,
          verifiedAt: row.verified_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "customer:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);
    const before = await prisma.customers.findFirst({
      where: { id, organization_id: session.organization.id },
    });
    if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "客户不存在");
    try {
      const updated = await prisma.customers.update({
        where: { id },
        data: {
          name: body.name,
          customer_code: body.customerCode === undefined ? undefined : body.customerCode || null,
          email: body.email === undefined ? undefined : body.email || null,
          phone: body.phone === undefined ? undefined : body.phone,
          company_name: body.companyName === undefined ? undefined : body.companyName,
          notes: body.notes === undefined ? undefined : body.notes,
          status: body.status,
          updated_at: new Date(),
        },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "customer.update",
        resourceType: "customer",
        resourceId: id,
        before: { name: before.name, status: before.status, email: before.email },
        after: { name: updated.name, status: updated.status, email: updated.email },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ updated: true }, requestId);
    } catch (error) {
      translatePrismaError(error, "客户编号已被占用");
    }
  });
}
