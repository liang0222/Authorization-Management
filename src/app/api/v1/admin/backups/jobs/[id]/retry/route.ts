import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { retryJobTarget } from "@/lib/services/backup/runner";

/**
 * 重传失败的副本（规格 16.10「重传失败副本」）。
 *
 * 不传 targetId 时，重传该作业所有失败目标。每次重传都是幂等的：
 * 先读远端，内容已一致就直接标 verified，不重复上传（见 retryJobTarget 的注释）。
 */
const schema = z.object({ targetId: z.string().uuid().nullish() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, schema).catch(() => ({ targetId: null }));

    const failed = await prisma.backup_job_targets.findMany({
      where: {
        job_id: id,
        organization_id: session.organization.id,
        status: "failed",
        ...(body.targetId ? { id: body.targetId } : {}),
      },
      select: { id: true },
    });
    if (failed.length === 0) throw new ApiError(400, "NOTHING_TO_RETRY", "该作业没有需要重传的失败目标");

    const results = [];
    for (const item of failed) {
      results.push(await retryJobTarget(id, session.organization.id, item.id, session.user.id));
    }

    return okResponse({ attempted: results.length, results }, requestId);
  });
}
