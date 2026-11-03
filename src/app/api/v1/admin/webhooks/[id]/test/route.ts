import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";
import { deliverTestEvent } from "@/lib/services/webhook-dispatcher";

/**
 * 测试投递（规格 27.19）。
 *
 * 给指定端点发一条 `webhook.test` 事件并同步返回结果，用于上线联调：
 * 「配好了地址和密钥，到底能不能收到、签名对不对」。
 *
 * 限制：每分钟最多 5 次，避免把测试按钮当压测工具打爆客户回调地址。
 */
const MIN_INTERVAL_MS = 60_000;
const MAX_PER_WINDOW = 5;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "webhook:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const endpoint = await prisma.webhook_endpoints.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, url: true, status: true },
    });
    if (!endpoint) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Webhook 端点不存在");
    if (endpoint.status !== "active") {
      throw new ApiError(409, "CONFLICT", "端点已停用，启用后才能测试投递");
    }

    const recent = await prisma.webhook_deliveries.count({
      where: {
        endpoint_id: endpoint.id,
        event_type: "webhook.test",
        created_at: { gte: new Date(Date.now() - MIN_INTERVAL_MS) },
      },
    });
    if (recent >= MAX_PER_WINDOW) {
      throw new ApiError(429, "RATE_LIMITED", "测试投递过于频繁，请稍后再试");
    }

    const result = await deliverTestEvent(endpoint.id, session.organization.id);

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "webhook.test_delivery",
      resourceType: "webhook_endpoint",
      resourceId: endpoint.id,
      after: {
        outcome: result.outcome,
        responseStatus: result.responseStatus,
        eventId: result.eventId,
      },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      {
        ...result,
        endpointId: endpoint.id,
        url: endpoint.url,
        // 给前端一句人话，避免只有状态码看不懂
        message:
          result.outcome === "succeeded"
            ? `投递成功（HTTP ${result.responseStatus}），请到接收端核对 X-License-Signature。`
            : result.outcome === "dead"
              ? `投递失败且不再重试：${result.error ?? "未知原因"}`
              : `投递失败，已安排重试：${result.error ?? "未知原因"}`,
      },
      requestId,
    );
  });
}
