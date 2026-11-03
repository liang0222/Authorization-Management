import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";
import { createAdapter, type AdapterRow } from "@/lib/services/backup/factory";

/**
 * 连接测试（规格 16.11.4：认证 → 列举/建目录 → 上传 → 下载比对 SHA-256 → 删除）。
 *
 * 每一步都单独返回结果，失败时明确指出卡在哪一步 —— 「连接失败」这种笼统结论
 * 在生产排障时几乎没用，而 /16.11.8 要求的是分阶段结果。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const row = await prisma.backup_storage_destinations.findFirst({
      where: { id, organization_id: session.organization.id },
    });
    if (!row) throw new ApiError(404, "NOT_FOUND", "存储目标不存在");

    let steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    let capability: Record<string, boolean> = {};
    let passed = false;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    try {
      const adapter = await createAdapter(row as unknown as AdapterRow, session.organization.id);
      steps = await adapter.test();
      capability = await adapter.capabilities();
      passed = steps.every((item) => item.ok);
      if (!passed) {
        const failed = steps.find((item) => !item.ok);
        errorCode = "TEST_STEP_FAILED";
        errorMessage = failed ? `${failed.step}: ${failed.detail ?? "失败"}` : "连接测试未通过";
      }
    } catch (error) {
      // 适配器初始化就失败（配置缺项、凭证解不开、协议未支持）也算测试失败，不抛 500。
      errorCode = (error as { code?: string }).code ?? "ADAPTER_INIT_FAILED";
      errorMessage = (error as Error).message;
      steps = [{ step: "初始化适配器", ok: false, detail: errorMessage }];
    }

    await prisma.backup_storage_destinations.update({
      where: { id: row.id },
      data: {
        last_tested_at: new Date(),
        last_test_status: passed ? "passed" : "failed",
        last_test_error_code: errorCode,
        last_test_error: errorMessage,
        capability_snapshot: capability as never,
      },
    });

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "backup.destination_test",
      resourceType: "backup_storage_destination",
      resourceId: row.id,
      after: { passed, steps: steps.length, error_code: errorCode },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      { passed, steps, capability, errorCode, errorMessage, testedAt: new Date().toISOString() },
      requestId,
    );
  });
}
