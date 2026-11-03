import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";

const customerSchema = z.object({
  name: z.string().trim().min(1, "请填写客户名称").max(160),
  customerCode: z.string().trim().max(80).nullish(),
  email: z.string().trim().email("邮箱格式不正确").max(254).nullish().or(z.literal("")),
  phone: z.string().trim().max(40).nullish(),
  companyName: z.string().trim().max(160).nullish(),
  notes: z.string().max(2000).nullish(),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "customer:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const status = url.searchParams.get("status");
    const where = {
      organization_id: session.organization.id,
      ...(status && ["active", "disabled", "archived"].includes(status)
        ? { status: status as "active" | "disabled" | "archived" }
        : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { email: { contains: query.q, mode: "insensitive" as const } },
              { company_name: { contains: query.q, mode: "insensitive" as const } },
              { customer_code: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.customers.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        include: {
          _count: { select: { licenses: true, customer_identities: true } },
        },
      }),
      prisma.customers.count({ where }),
    ]);

    const activeLicenses = await prisma.$queryRawUnsafe<Array<{ customer_id: string; active: bigint }>>(
      `SELECT customer_id, count(*)::bigint AS active FROM licenses
       WHERE organization_id = $1::uuid AND deleted_at IS NULL
         AND admin_status IN ('pending','active') AND customer_id = ANY($2::uuid[])
       GROUP BY customer_id`,
      session.organization.id,
      rows.map((row) => row.id),
    );
    const activeMap = new Map(activeLicenses.map((row) => [row.customer_id, Number(row.active)]));

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          customerCode: row.customer_code,
          name: row.name,
          email: row.email,
          phone: row.phone,
          companyName: row.company_name,
          notes: row.notes,
          status: row.status,
          createdAt: row.created_at.toISOString(),
          counts: {
            licenses: row._count.licenses,
            activeLicenses: activeMap.get(row.id) ?? 0,
            identities: row._count.customer_identities,
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
  return withAdmin(req, "customer:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, customerSchema);
    try {
      const customer = await prisma.customers.create({
        data: {
          organization_id: session.organization.id,
          name: body.name,
          customer_code: body.customerCode || null,
          email: body.email || null,
          phone: body.phone || null,
          company_name: body.companyName || null,
          notes: body.notes || null,
        },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "customer.create",
        resourceType: "customer",
        resourceId: customer.id,
        after: { name: customer.name, email: customer.email },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ id: customer.id }, requestId, { status: 201 });
    } catch (error) {
      translatePrismaError(error, "客户编号已存在");
    }
  });
}
