import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { dispatchDueWebhooks } from "@/lib/services/webhook-dispatcher";

/**
 * 重放失败投递（规格第 8 节：多次失败进入 dead 状态供管理后台重放）。
 *
 * 只允许 failed / dead 两种终态重放，避免与正在 delivering 的记录产生并发重复投递；
 * 重放不删除、不改 event_id，依靠 (endpoint_id, event_id) 唯一约束保证接收方幂等键稳定。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "webhook:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;

    // 用关系过滤直接限定租户：投递记录本身没有 organization_id 列。
    const delivery = await prisma.webhook_deliveries.findFirst({
      where: { id, webhook_endpoints: { organization_id: session.organization.id } },
      include: {
        webhook_endpoints: { select: { id: true, url: true, status: true } },
      },
    });
    if (!delivery) throw new ApiError(404, "RESOURCE_NOT_FOUND", "投递记录不存在");

    if (delivery.status !== "dead" && delivery.status !== "failed") {
      throw new ApiError(409, "CONFLICT", "只有 failed 或 dead 状态的投递可以重放");
    }
    if (delivery.webhook_endpoints.status === "archived") {
      throw new ApiError(409, "CONFLICT", "端点已归档，不能重放投递");
    }

    const now = new Date();
    try {
      const updated = await prisma.webhook_deliveries.update({
        where: { id },
        data: {
          status: "pending",
          // 重放算一次新的尝试，attempt_count 累加，便于后台看“这条已经试过几次”。
          attempt_count: { increment: 1 },
          next_attempt_at: now,
        },
      });

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "webhook.replay",
        resourceType: "webhook_delivery",
        resourceId: id,
        before: {
          status: delivery.status,
          attemptCount: delivery.attempt_count,
          endpointId: delivery.endpoint_id,
          eventId: delivery.event_id,
        },
        after: {
          status: updated.status,
          attemptCount: updated.attempt_count,
          nextAttemptAt: updated.next_attempt_at?.toISOString() ?? null,
        },
        requestId,
        ip,
        userAgent,
      });

      // 重放后立刻投递一次，而不是干等下一个轮询周期：运维点了按钮就该看到结果。
      // 投递失败不影响接口成功——结果会体现在返回的 dispatch 里。
      const dispatch = await dispatchDueWebhooks(5).catch(() => null);
      const after = await prisma.webhook_deliveries.findUnique({
        where: { id },
        select: { status: true, response_status: true, last_error: true, attempt_count: true },
      });

      return okResponse(
        {
          id: updated.id,
          status: after?.status ?? updated.status,
          responseStatus: after?.response_status ?? null,
          lastError: after?.last_error ?? null,
          attemptCount: after?.attempt_count ?? updated.attempt_count,
          nextAttemptAt: updated.next_attempt_at?.toISOString() ?? null,
          eventId: updated.event_id,
          eventType: updated.event_type,
          dispatch,
        },
        requestId,
      );
    } catch (error) {
      translatePrismaError(error, "投递重放失败");
    }
  });
}
