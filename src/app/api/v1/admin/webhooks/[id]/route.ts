import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { sealSecret } from "@/lib/auth/secretbox";
import { createHash, randomBytes } from "node:crypto";
import { config } from "@/lib/config";
import { OUTBOUND_URL_MESSAGES, checkOutboundUrl } from "@/lib/domain/outbound-url";

/**
 * 单个 Webhook 端点的更新与归档。
 * - url 与创建时同规则：https，或开发环境的本机 http。
 * - eventTypes 只能取规格第 8 节的白名单。
 * - 归档是软删除（status=archived），保留历史投递记录供审计与重放追溯。
 */

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

const patchSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    eventTypes: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .min(1, "请至少订阅一个事件")
      .max(WEBHOOK_EVENT_TYPES.length)
      .optional(),
    status: z.enum(RECORD_STATUSES).optional(),
    /**
     * 轮换签名密钥：新 secret 只在本次响应里返回一次，库里换成新的 hash + 密文。
     * 旧 secret 立即失效——这是有意的，避免“两个密钥都能签”的灰期被利用。
     */
    rotateSecret: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.url !== undefined ||
      value.eventTypes !== undefined ||
      value.status !== undefined ||
      value.rotateSecret === true,
    { message: "请提供要更新的字段" },
  );

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "webhook:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    // 与其它资源详情一致：跨租户与不存在一律 404，不返回 403 暴露存在性。
    const endpoint = await prisma.webhook_endpoints.findFirst({
      where: { id, organization_id: session.organization.id },
      select: {
        id: true,
        product_id: true,
        url: true,
        event_types: true,
        status: true,
        created_at: true,
        products: { select: { id: true, name: true, code: true } },
      },
    });
    if (!endpoint) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Webhook 端点不存在");
    return okResponse(
      {
        webhook: {
          id: endpoint.id,
          productId: endpoint.product_id,
          url: endpoint.url,
          eventTypes: endpoint.event_types,
          status: endpoint.status,
          createdAt: endpoint.created_at,
          product: endpoint.products,
        },
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "webhook:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);

    const endpoint = await prisma.webhook_endpoints.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, url: true, event_types: true, status: true },
    });
    if (!endpoint) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Webhook 端点不存在");
    if (endpoint.status === "archived") {
      throw new ApiError(409, "CONFLICT", "已归档的 Webhook 端点不可再修改");
    }

    const nextEventTypes = body.eventTypes ? Array.from(new Set(body.eventTypes)) : endpoint.event_types;

    const rotated = body.rotateSecret
      ? `whsec_${randomBytes(32).toString("base64url")}`
      : null;

    try {
      const updated = await prisma.webhook_endpoints.update({
        where: { id },
        data: {
          url: body.url,
          event_types: nextEventTypes,
          status: body.status,
          ...(rotated
            ? {
                secret_hash: createHash("sha256").update(rotated).digest(),
                secret_enc: sealSecret(rotated),
              }
            : {}),
        },
      });

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        // 归档单独记一个动作，便于审计按“谁把端点下线”筛选。
        action: body.status === "archived" ? "webhook.archive" : "webhook.update",
        // 轮换密钥单独标注，审计里能查到“什么时候换过”，但查不到密钥本身。
        resourceType: "webhook_endpoint",
        resourceId: id,
        before: { url: endpoint.url, eventTypes: endpoint.event_types, status: endpoint.status },
        after: { url: updated.url, eventTypes: updated.event_types, status: updated.status },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(
        {
          id: updated.id,
          url: updated.url,
          status: updated.status,
          eventTypes: updated.event_types,
          // 只有轮换那一次会返回明文，前端必须提示用户立刻保存。
          ...(rotated ? { secret: rotated, secretRotatedAt: new Date().toISOString() } : {}),
        },
        requestId,
      );
    } catch (error) {
      translatePrismaError(error, "Webhook 端点更新失败");
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "webhook:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const endpoint = await prisma.webhook_endpoints.findFirst({
      where: { id, organization_id: session.organization.id },
      select: { id: true, url: true, status: true },
    });
    if (!endpoint) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Webhook 端点不存在");
    if (endpoint.status === "archived") {
      throw new ApiError(409, "CONFLICT", "Webhook 端点已归档");
    }

    const updated = await prisma.webhook_endpoints.update({
      where: { id },
      data: { status: "archived" },
    });
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "webhook.archive",
      resourceType: "webhook_endpoint",
      resourceId: id,
      before: { status: endpoint.status, url: endpoint.url },
      after: { status: updated.status },
      requestId,
      ip,
      userAgent,
    });

    return okResponse({ id, status: updated.status }, requestId);
  });
}
