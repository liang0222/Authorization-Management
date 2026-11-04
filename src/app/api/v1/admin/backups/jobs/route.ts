import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { runBackup } from "@/lib/services/backup/runner";
import { applyRetention, sweepStagingFiles } from "@/lib/services/backup/retention";
import { notifyBackupConfigIssue } from "@/lib/services/backup/alerts";
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

    const policy = body.policyId
      ? await prisma.backup_policies.findFirst({
          where: { id: body.policyId, organization_id: session.organization.id },
          select: { id: true, name: true, enabled: true },
        })
      : null;
    if (body.policyId && !policy) throw new ApiError(404, "NOT_FOUND", "备份策略不存在");

    let result;
    try {
      result = await runBackup({
        organizationId: session.organization.id,
        userId: session.user.id,
        policyId: body.policyId ?? null,
        trigger: body.trigger ?? "manual",
        onlyDestinationId: body.onlyDestinationId ?? null,
      });
    } catch (error) {
      const message = (error as Error).message;
      // 作业建出来之后才失败的，runBackup 内部已经按最终状态写审计 + 打 stdout 告警；
      // 但「一个目标都没有」这类在 pg_dump 之前就抛的配置错误还没有 job 可挂，
      // 必须在这里补一条策略级告警，否则后台点一次「立即备份」失败，只有页面上一句红字。
      const noTarget = message.includes("没有可用的备份目标");
      if (noTarget && policy) {
        await notifyBackupConfigIssue({
          organizationId: session.organization.id,
          policyId: policy.id,
          policyName: policy.name,
          reason: message.slice(0, 300),
        });
      }
      throw new ApiError(422, "BACKUP_FAILED", message.slice(0, 300));
    }

    const job = await prisma.backup_jobs.findUniqueOrThrow({ where: { id: result.jobId }, include: INCLUDE });

    // 手动备份成功后同样执行保留清理：否则「每天自动跑」才瘦身，
    // 而频繁手动备份的机器磁盘只增不减——正是这个缺口最初被发现的场景。
    let retention = null;
    if (result.status !== "failed" && body.policyId) {
      try {
        retention = await applyRetention({
          organizationId: session.organization.id,
          policyId: body.policyId,
          actorId: session.user.id,
        });
      } catch (error) {
        console.error("[backup] 手动备份后的保留清理失败", { policyId: body.policyId, error });
      }
    }

    // 手动路径同样清扫暂存目录：频繁手点「立即备份」的机器不会跑定时调度，
    // 孤儿与过期失败文件只能靠这里清。
    let stagingSweep = null;
    try {
      stagingSweep = await sweepStagingFiles({ organizationId: session.organization.id, actorId: session.user.id });
    } catch (error) {
      console.error("[backup] 手动备份后的暂存清扫失败", { error });
    }

    return okResponse({ ...result, job: jobDto(job), retention, stagingSweep }, requestId, { status: 201 });
  });
}
