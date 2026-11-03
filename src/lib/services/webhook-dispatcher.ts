import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { openSecret } from "@/lib/auth/secretbox";
import { config } from "@/lib/config";
import { safePostJson } from "@/lib/domain/outbound-http";

/**
 * Webhook 投递器（规格 8 / 27.15）。
 *
 * 之前只有 `enqueueWebhook()` 写 pending，没有任何进程真正发出请求——事件永远停在队列里。
 * 这里补上真正的投递：
 * - 领取任务用 `FOR UPDATE SKIP LOCKED`，多实例并发跑也不会重复投递。
 * - 签名头 `X-License-Signature: v1=<hex hmac>`，签名原文是 `{timestamp}.{raw body}`。
 * - 失败按指数退避重试，超过 MAX_ATTEMPTS 置为 `dead`（保留记录，可人工重放）。
 * - 5xx / 网络错误重试；4xx 视为对方拒绝，直接 `failed` 不重试（重试也没用）。
 */

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
/** 退避序列（秒）：30s, 2m, 8m, 32m, 2h。第 6 次失败进 dead。 */
const BACKOFF_SECONDS = [30, 120, 480, 1920, 7200];

export interface DispatchSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
}

interface ClaimedDelivery {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
  url: string;
  secret_enc: string | null;
  endpoint_status: string;
  product_id: string;
}

function signatureFor(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * 领取一批到期任务。用一条 UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 * 把「领取」做成原子操作，避免两个 worker 抢到同一行。
 */
async function claimBatch(limit: number): Promise<ClaimedDelivery[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE webhook_deliveries d
    SET status = 'delivering', attempt_count = d.attempt_count + 1
    FROM (
      SELECT id FROM webhook_deliveries
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS due
    WHERE d.id = due.id
    RETURNING d.id
  `;
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const deliveries = await prisma.webhook_deliveries.findMany({
    where: { id: { in: ids } },
    include: { webhook_endpoints: { select: { url: true, secret_enc: true, status: true, product_id: true } } },
  });
  return deliveries.map((delivery) => ({
    id: delivery.id,
    event_id: delivery.event_id,
    event_type: delivery.event_type,
    payload: delivery.payload,
    attempt_count: delivery.attempt_count,
    url: delivery.webhook_endpoints.url,
    secret_enc: delivery.webhook_endpoints.secret_enc,
    endpoint_status: delivery.webhook_endpoints.status,
    product_id: delivery.webhook_endpoints.product_id,
  }));
}

async function deliverOne(delivery: ClaimedDelivery): Promise<"succeeded" | "failed" | "dead" | "skipped"> {
  // 端点被停用/归档时不应该再往外发，直接标记失败并说明原因。
  if (delivery.endpoint_status !== "active") {
    await prisma.webhook_deliveries.update({
      where: { id: delivery.id },
      data: {
        status: "dead",
        last_error: `endpoint_${delivery.endpoint_status}`,
        response_status: null,
      },
    });
    return "dead";
  }
  if (!delivery.secret_enc) {
    await prisma.webhook_deliveries.update({
      where: { id: delivery.id },
      data: { status: "dead", last_error: "missing_secret" },
    });
    return "dead";
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let secret: string;
  try {
    secret = openSecret(delivery.secret_enc);
  } catch {
    await prisma.webhook_deliveries.update({
      where: { id: delivery.id },
      data: { status: "dead", last_error: "secret_decrypt_failed" },
    });
    return "dead";
  }

  let responseStatus: number | null = null;
  let errorText: string | null = null;
  {
    // SSRF 防护：解析 DNS 后校验每个地址，且用同一个已校验地址建连（见 outbound-http.ts）。
    // 不跟随重定向：回调地址若被劫持成 30x，跟随会把数据发到未验证的主机。
    const result = await safePostJson({
      url: delivery.url,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "ziming-license-webhook/1.5",
        "x-license-event-id": delivery.event_id,
        "x-license-event-type": delivery.event_type,
        "x-license-timestamp": timestamp,
        "x-license-signature": signatureFor(secret, timestamp, body),
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      policy: { allowHttpLoopback: config.deploymentEnv !== "production" },
    });
    responseStatus = result.status;
    if (result.error) errorText = result.error;
    if (responseStatus !== null && responseStatus >= 200 && responseStatus < 300) {
      await prisma.webhook_deliveries.update({
        where: { id: delivery.id },
        data: {
          status: "succeeded",
          response_status: responseStatus,
          delivered_at: new Date(),
          last_error: null,
          next_attempt_at: null,
        },
      });
      return "succeeded";
    }
    errorText = errorText ?? `HTTP ${responseStatus}`;
  }

  /**
   * SSRF 拦截是终态：地址本身被策略拒绝，重试一万次也还是被拒绝。
   * 继续重试只会让队列积压，且每次都尝试一次 DNS 解析。
   */
  const blocked = errorText?.startsWith("blocked_url:") || errorText === "blocked_address";
  const retryable =
    !blocked && (responseStatus === null || responseStatus >= 500 || responseStatus === 429);
  const nextAttempt = delivery.attempt_count + 1;
  if (!retryable || nextAttempt >= MAX_ATTEMPTS) {
    await prisma.webhook_deliveries.update({
      where: { id: delivery.id },
      data: {
        status: "dead",
        response_status: responseStatus,
        last_error: errorText?.slice(0, 500) ?? "unknown_error",
      },
    });
    return "dead";
  }

  const backoff = BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];
  await prisma.webhook_deliveries.update({
    where: { id: delivery.id },
    data: {
      status: "pending",
      response_status: responseStatus,
      last_error: errorText?.slice(0, 500) ?? null,
      next_attempt_at: new Date(Date.now() + backoff * 1000),
    },
  });
  return "failed";
}

/**
 * 测试投递（规格 27.19「Webhook 配置 / 投递日志 / 重试死信」的联调入口）。
 *
 * 与真实事件的差别：
 * - 事件类型固定 `webhook.test`，不参与 event_types 订阅过滤，因此哪怕端点没订阅任何
 *   业务事件也能收到一条测试消息；
 * - 立即投递一次并同步返回结果（HTTP 状态码、耗时、错误），管理员不用等 worker 的 5s 轮询
 *   —— 联调时最需要的是「现在到底通不通」；
 * - 失败按同样规则落库（4xx/SSRF 拦截直接 dead，5xx/网络错误留在 pending 走退避），
 *   这样投递记录页能看到这条测试的真实轨迹。
 */
export interface TestDeliveryResult {
  deliveryId: string;
  eventId: string;
  outcome: "succeeded" | "failed" | "dead" | "skipped";
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
}

export async function deliverTestEvent(
  endpointId: string,
  organizationId: string,
): Promise<TestDeliveryResult> {
  const endpoint = await prisma.webhook_endpoints.findFirst({
    where: { id: endpointId, organization_id: organizationId },
    select: { id: true, url: true, secret_enc: true, status: true, product_id: true },
  });
  if (!endpoint) throw new Error("endpoint_not_found");

  const eventId = `evt_test_${randomBytes(8).toString("hex")}`;
  const payload = {
    event_id: eventId,
    event_type: "webhook.test",
    occurred_at: new Date().toISOString(),
    api_version: "v1",
    data: {
      message: "这是一条测试事件，由管理后台手动触发，可安全忽略。",
      endpoint_id: endpoint.id,
    },
  };

  const created = await prisma.webhook_deliveries.create({
    data: {
      endpoint_id: endpoint.id,
      event_id: eventId,
      event_type: "webhook.test",
      payload: payload as never,
      status: "pending",
      next_attempt_at: new Date(),
    },
    select: { id: true },
  });

  const started = Date.now();
  const outcome = await deliverOne({
    id: created.id,
    event_id: eventId,
    event_type: "webhook.test",
    payload,
    attempt_count: 0,
    url: endpoint.url,
    secret_enc: endpoint.secret_enc,
    endpoint_status: endpoint.status,
    product_id: endpoint.product_id,
  });

  const row = await prisma.webhook_deliveries.findUnique({
    where: { id: created.id },
    select: { response_status: true, last_error: true },
  });

  return {
    deliveryId: created.id,
    eventId,
    outcome,
    responseStatus: row?.response_status ?? null,
    error: row?.last_error ?? null,
    durationMs: Date.now() - started,
  };
}

/** 领取并投递一批到期任务，返回统计。可由定时器或手动触发调用。 */
export async function dispatchDueWebhooks(limit = 20): Promise<DispatchSummary> {
  const batch = await claimBatch(limit);
  const summary: DispatchSummary = { claimed: batch.length, succeeded: 0, failed: 0, dead: 0 };
  for (const delivery of batch) {
    const outcome = await deliverOne(delivery);
    if (outcome === "succeeded") summary.succeeded += 1;
    else if (outcome === "failed") summary.failed += 1;
    else if (outcome === "dead") summary.dead += 1;
  }
  return summary;
}

/** 手动重放：把一条 dead/failed 记录放回队列，并清零退避时间。 */
export async function requeueDelivery(deliveryId: string, organizationId: string) {
  const delivery = await prisma.webhook_deliveries.findFirst({
    where: {
      id: deliveryId,
      webhook_endpoints: { organization_id: organizationId },
    },
    select: { id: true, status: true },
  });
  if (!delivery) return null;
  return prisma.webhook_deliveries.update({
    where: { id: delivery.id },
    data: { status: "pending", next_attempt_at: null, last_error: null },
  });
}

/**
 * 启动常驻投递循环。由 `src/instrumentation.ts` 在进程启动时调用一次。
 *
 * 轮询间隔可用 `WEBHOOK_WORKER_INTERVAL_MS` 调整；`DISABLE_WEBHOOK_WORKER=true` 可整体关闭
 * （多实例部署时只让一个实例投递，其余关掉即可，领取逻辑本身也是互斥的）。
 */
export function startWebhookWorker(): void {
  const intervalMs = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS ?? 5_000);

  const tick = async () => {
    try {
      const summary = await dispatchDueWebhooks(20);
      if (summary.claimed > 0) {
        console.log(
          `[webhook] claimed=${summary.claimed} ok=${summary.succeeded} retry=${summary.failed} dead=${summary.dead}`,
        );
      }
    } catch (error) {
      // 投递器不能因为一次失败就退出：下一轮继续。
      console.error("[webhook] dispatch cycle failed", error);
    }
  };

  setInterval(() => void tick(), intervalMs);
  // 启动时立刻来一轮，避免冷启动后要等一个完整周期。
  setTimeout(() => void tick(), 1_000);
  console.log(`[webhook] dispatcher started, interval=${intervalMs}ms`);
}
