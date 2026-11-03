import type { NextRequest } from "next/server";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";
import { verifyJobIntegrity } from "@/lib/services/backup/runner";

/**
 * 完整性校验（规格 16.10 的「完整性检查」）。
 *
 * 只读：重算本地暂存文件的 SHA-256 并与作业记录比对。
 * 注意它证明的是「暂存文件没坏」，不是「远端副本没坏」 —— 远端完整性靠作业时的
 * 下载回读校验（uploading → verifying → verified）。两者不能互相替代。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    try {
      const result = await verifyJobIntegrity(id, session.organization.id);
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "backup.verify",
        resourceType: "backup_job",
        resourceId: id,
        after: { ok: result.ok, actual: result.actual },
        requestId,
        ip,
        userAgent,
      });
      return okResponse(result, requestId);
    } catch (error) {
      throw new ApiError(422, "VERIFY_FAILED", (error as Error).message.slice(0, 300));
    }
  });
}
