import type { NextRequest } from "next/server";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { runRestoreTest } from "@/lib/services/backup/runner";

/**
 * 隔离恢复演练（规格 16.10「隔离恢复测试」）。
 *
 * 做的事：解密备份 → 建一个临时库 → pg_restore 进去 → 对账（表数量、授权行数、关键列完整性）→ 删库。
 * 绝不在生产库上做恢复：这是「点击即覆盖生产库」的替代方案，也是唯一能诚实验证 RTO 的方式。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:restore", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    try {
      const result = await runRestoreTest(id, session.organization.id, session.user.id);
      return okResponse(result, requestId, { status: 201 });
    } catch (error) {
      throw new ApiError(422, "RESTORE_TEST_FAILED", (error as Error).message.slice(0, 300));
    }
  });
}
