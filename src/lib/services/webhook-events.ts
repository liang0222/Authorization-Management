import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Webhook 事件的统一入队入口（规格第 8 节的 10 个事件）。
 *
 * 之前 `enqueueWebhook` 是 `activations.ts` 里的私有函数，于是只有「激活/解绑」会发事件，
 * 管理员在后台做的暂停、恢复、吊销、续费完全不发——Webhook 用户看到的授权状态会永远停在
 * 激活那一刻。改成共享模块后，任何状态变更都必须经过这里。
 *
 * 入队失败绝不影响主流程：事件是副作用，不能因为 Webhook 表写失败就回滚一次授权操作。
 */

/**
 * 事件清单先写成数组，类型再由数组推导。
 *
 * 反过来（先写 union、再手抄一份字符串数组给文档用）就会出现「加了新事件、
 * 类型对、文档漏」的分裂；数组是唯一事实来源，`llms.txt`、设置页的事件多选框、
 * 测试都读它。
 */
export const WEBHOOK_EVENT_TYPES = [
  "license.activated",
  "license.renewed",
  "license.suspended",
  "license.resumed",
  "license.revoked",
  "license.expired",
  "activation.created",
  "activation.released",
  "activation.blocked",
  "entitlements.updated",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEnvelope {
  event_id: string;
  event_type: WebhookEventType;
  occurred_at: string;
  api_version: "v1";
  data: Record<string, unknown>;
}

/**
 * 组装标准事件信封并写入投递队列。
 * `data` 只放调用方明确给出的事实，不塞整行记录——Webhook 收方不该拿到内部字段。
 */
export async function enqueueWebhook(
  organizationId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const endpoints = await prisma.webhook_endpoints.findMany({
      where: {
        organization_id: organizationId,
        status: "active",
        event_types: { has: eventType },
      },
      select: { id: true },
    });
    if (endpoints.length === 0) return;

    const envelope: WebhookEnvelope = {
      event_id: `evt_${randomBytes(8).toString("hex")}`,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      api_version: "v1",
      data,
    };

    await prisma.webhook_deliveries.createMany({
      // 同一 event_id 发给多个端点，收方可用 event_id 做幂等。
      data: endpoints.map((endpoint) => ({
        endpoint_id: endpoint.id,
        event_id: envelope.event_id,
        event_type: eventType,
        payload: envelope as never,
        status: "pending" as const,
        next_attempt_at: new Date(),
      })),
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("[webhook] 入队失败", error);
  }
}
