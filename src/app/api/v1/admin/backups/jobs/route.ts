import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { runBackup } from "@/lib/services/backup/runner";
import { jobDto } from "@/lib/services/backup/serialize";

/**
 * 备份作业：列表与「立即备份」（规格 16.10 的高风险操作之一）。
 *
 * 立即备份是同步执行的：本项目的库是单租户演示规模（几十张表、几十万行以内），
 * pg_dump + 加密 + 上传会在几秒内完成，同步返回结果对操作者更友好。
 * 真正的生产规模应改为队列 + 轮询，这一点记在 docs/handoff.md 的遗留项里。
 */

const INCLUDE = {
  backup_job_targets: { include: { backup_storage_destinations: { select: { name: true, provider_type: true } } } },
  backup_policies: { select: { name: true } },
  users: { select: { display_name: true, email: true } },
} as const;

const runSchema = z.object({
  policyId: z.string().uuid().nullish(),
  onlyDestinationId: z.string().uuid().nullish(),
  trigger: z.enum(["manual", "scheduled", "retry"]).optional(),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const query = readListQuery(req.nextUrl, 20);
    const status = query.raw.get("status");
    const where = {
      organization_id: session.organization.id,
      ...(status && status !== "all" ? { status: status as never } : {}),
      ...(query.q ? { backup_id: { contains: query.q, mode: "insensitive" as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.backup_jobs.findMany({
        where,
        include: INCLUDE,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
      }),
      prisma.backup_jobs.count({ where }),
    ]);
    return okResponse(
      {
        items: rows.map(jobDto),
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

export async function POST(req: NextRequest) {
  return withAdmin(req, "backup:write", async ({ session, requestId }) => {
    const body = await readJson(req, runSchema);

    if (body.policyId) {
      const policy = await prisma.backup_policies.findFirst({
        where: { id: body.policyId, organization_id: session.organization.id },
        select: { id: true, enabled: true },
      });
      if (!policy) throw new ApiError(404, "NOT_FOUND", "备份策略不存在");
    }

    try {
      const result = await runBackup({
        organizationId: session.organization.id,
        userId: session.user.id,
        policyId: body.policyId ?? null,
        trigger: body.trigger ?? "manual",
        onlyDestinationId: body.onlyDestinationId ?? null,
      });
      const job = await prisma.backup_jobs.findUniqueOrThrow({ where: { id: result.jobId }, include: INCLUDE });
      return okResponse({ ...result, job: jobDto(job) }, requestId, { status: 201 });
    } catch (error) {
      // 备份失败已经把 job 标成 failed 并写入 error_code，这里把原因原样带出去。
      throw new ApiError(422, "BACKUP_FAILED", (error as Error).message.slice(0, 300));
    }
  });
}
