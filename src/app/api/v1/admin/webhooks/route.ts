import type { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { sealSecret } from "@/lib/auth/secretbox";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, pageResult, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { config } from "@/lib/config";
import { OUTBOUND_URL_MESSAGES, checkOutboundUrl } from "@/lib/domain/outbound-url";

/**
 * Webhook 端点管理（规格第 8 节）。
 *
 * 安全决策：
 * - 端点地址必须 https；只有 localhost/回环地址允许 http，方便本地联调，避免在公网发送明文回调。
 * - 签名 secret 只在创建/轮换响应出现一次，数据库只存 sha256(secret)（webhook_endpoints.secret_hash）。
 * - 接收方按 `X-License-Signature: v1=HMAC-SHA256(timestamp + "." + raw_body)` 验签，服务端永不回传 secret。
 */

/** 规格第 8 节的事件白名单：不在列表中的事件类型一律拒绝。 */
const WEBHOOK_EVENT_TYPES = [
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

const RECORD_STATUSES = ["active", "disabled", "archived"] as const;

/**
 * 允许 http 的开发地址：仅非生产环境放行回环。
 * 真正的私网拦截在 `checkOutboundUrl` 里，投递时还会用 `safeLookup` 复核 DNS 结果。
 */
const allowHttpLoopback = config.deploymentEnv !== "production";

function describeWebhookUrlProblem(raw: string): string | null {
  const problem = checkOutboundUrl(raw, { allowHttpLoopback });
  return problem ? OUTBOUND_URL_MESSAGES[problem] : null;
}

const webhookUrlSchema = z
  .string()
  .trim()
  .min(1, "请填写回调地址")
  .max(2000)
  .superRefine((value, ctx) => {
    const message = describeWebhookUrlProblem(value);
    if (message) ctx.addIssue({ code: "custom", message });
  });

const createSchema = z.object({
  productId: z.string().uuid("请选择产品"),
  url: webhookUrlSchema,
  eventTypes: z
    .array(z.enum(WEBHOOK_EVENT_TYPES))
    .min(1, "请至少订阅一个事件")
    .max(WEBHOOK_EVENT_TYPES.length),
});

export async function GET(req: NextRequest) {
  return withAdmin(req, "webhook:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const productId = url.searchParams.get("productId");
    const status = url.searchParams.get("status");
    const where = {
      organization_id: session.organization.id,
      ...(productId ? { product_id: productId } : {}),
      ...(status && (RECORD_STATUSES as readonly string[]).includes(status)
        ? { status: status as (typeof RECORD_STATUSES)[number] }
        : {}),
      ...(query.q ? { url: { contains: query.q, mode: "insensitive" as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.webhook_endpoints.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: query.skip,
        take: query.pageSize,
        // secret_hash 不查询：列表只需要“是否配置”，这里所有端点创建时必然有 secret。
        select: {
          id: true,
          product_id: true,
          url: true,
          event_types: true,
          status: true,
          created_at: true,
          products: { select: { id: true, name: true, code: true } },
        },
      }),
      prisma.webhook_endpoints.count({ where }),
    ]);

    const endpointIds = rows.map((row) => row.id);
    interface LastDeliveryRow {
      endpoint_id: string;
      status: string;
      response_status: number | null;
      created_at: Date;
      delivered_at: Date | null;
    }
    interface DeliveryStatRow {
      endpoint_id: string;
      succeeded: bigint;
      failed: bigint;
    }
    // 参数化 raw SQL：endpoint_id 走 $1::uuid[]，不做字符串拼接。
    const [lastDeliveries, stats] =
      endpointIds.length > 0
        ? await Promise.all([
            prisma.$queryRawUnsafe<LastDeliveryRow[]>(
              `SELECT DISTINCT ON (endpoint_id)
                      endpoint_id, status::text AS status, response_status, created_at, delivered_at
               FROM webhook_deliveries
               WHERE endpoint_id = ANY($1::uuid[])
               ORDER BY endpoint_id, created_at DESC`,
              endpointIds,
            ),
            prisma.$queryRawUnsafe<DeliveryStatRow[]>(
              `SELECT endpoint_id,
                      count(*) FILTER (WHERE status = 'succeeded')::bigint AS succeeded,
                      count(*) FILTER (WHERE status IN ('failed','dead'))::bigint AS failed
               FROM webhook_deliveries
               WHERE endpoint_id = ANY($1::uuid[])
                 AND created_at >= now() - interval '7 days'
               GROUP BY endpoint_id`,
              endpointIds,
            ),
          ])
        : ([[], []] as [LastDeliveryRow[], DeliveryStatRow[]]);
    const lastMap = new Map(lastDeliveries.map((row) => [row.endpoint_id, row]));
    const statsMap = new Map(stats.map((row) => [row.endpoint_id, row]));

    const items = rows.map((row) => {
      const last = lastMap.get(row.id);
      const stat = statsMap.get(row.id);
      return {
        id: row.id,
        url: row.url,
        status: row.status,
        eventTypes: row.event_types,
        productId: row.product_id,
        product: row.products,
        lastDelivery: last
          ? {
              status: last.status,
              responseStatus: last.response_status,
              createdAt: last.created_at.toISOString(),
              deliveredAt: last.delivered_at?.toISOString() ?? null,
            }
          : null,
        /** 近 7 天投递统计（succeeded 成功；failed + dead 视为失败）。 */
        last7d: {
          succeeded: Number(stat?.succeeded ?? 0),
          failed: Number(stat?.failed ?? 0),
        },
        createdAt: row.created_at.toISOString(),
      };
    });

    return okResponse(pageResult(items, total, query), requestId);
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "webhook:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, createSchema);

    const product = await prisma.products.findFirst({
      where: { id: body.productId, organization_id: session.organization.id },
      select: { id: true, name: true },
    });
    if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在");

    // 同一事件重复订阅没有意义，先归一化再入库。
    const eventTypes = Array.from(new Set(body.eventTypes));
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const secretHash = createHash("sha256").update(secret).digest();

    try {
      const created = await prisma.webhook_endpoints.create({
        data: {
          organization_id: session.organization.id,
          product_id: body.productId,
          url: body.url,
          secret_hash: secretHash,
          // 密文用于投递时做 HMAC 签名；secret_hash 只用于核对，两者职责不同。
          secret_enc: sealSecret(secret),
          event_types: eventTypes,
          status: "active",
        },
      });

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "webhook.create",
        resourceType: "webhook_endpoint",
        resourceId: created.id,
        // 审计只记录端点配置，secret 明文/摘要都不落审计。
        after: {
          product: product.name,
          url: created.url,
          eventTypes: created.event_types,
          status: created.status,
        },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          id: created.id,
          url: created.url,
          status: created.status,
          eventTypes: created.event_types,
          createdAt: created.created_at.toISOString(),
          // 一次性返回：用于接收方验签，之后只能重新轮换生成。
          secret,
          secretNotice: "secret 仅显示一次，请保存到接收方配置中用于校验签名",
        },
        requestId,
        { status: 201 },
      );
    } catch (error) {
      translatePrismaError(error, "Webhook 端点创建失败");
    }
  });
}
