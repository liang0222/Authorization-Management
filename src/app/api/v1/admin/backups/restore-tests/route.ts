import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, okResponse, readListQuery } from "@/lib/http/api";
import { restoreTestDto } from "@/lib/services/backup/serialize";

/** 恢复演练历史：每次演练的结论、逐项对账结果、实测 RPO/RTO。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const query = readListQuery(req.nextUrl, 20);
    const where = { organization_id: session.organization.id };
    const [rows, total] = await Promise.all([
      prisma.backup_restore_tests.findMany({
        where,
        include: { backup_jobs: { select: { backup_id: true } } },
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
      }),
      prisma.backup_restore_tests.count({ where }),
    ]);
    return okResponse(
      {
        items: rows.map(restoreTestDto),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
      },
      requestId,
    );
  });
}
