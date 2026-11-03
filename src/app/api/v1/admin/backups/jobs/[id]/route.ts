import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { jobDto } from "@/lib/services/backup/serialize";

/** 单个备份作业详情：目标级状态、大小、耗时、错误、校验时间。 */

const INCLUDE = {
  backup_job_targets: { include: { backup_storage_destinations: { select: { name: true, provider_type: true } } } },
  backup_policies: { select: { name: true } },
  users: { select: { display_name: true, email: true } },
} as const;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const row = await prisma.backup_jobs.findFirst({
      where: { id, organization_id: session.organization.id },
      include: INCLUDE,
    });
    if (!row) throw new ApiError(404, "NOT_FOUND", "备份作业不存在");
    return okResponse(jobDto(row), requestId);
  });
}
