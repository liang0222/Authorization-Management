import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

const reasonSchema = z.object({ reason: z.string().trim().min(2, "请填写原因").max(500) });

/**
 * 管理员设备操作（规格 3.3 / 4.5）：
 * - release：解绑，释放设备名额；是否返还累计激活次数由 refund_activation_on_release 决定。
 * - block：禁用设备（可恢复）。
 * - unblock：恢复被禁用设备（仍要求 License 本身有效）。
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  const permissionByAction: Record<string, string> = {
    release: "activation:release",
    block: "activation:block",
    unblock: "activation:block",
  };
  const permission = permissionByAction[action];
  if (!permission) {
    return withAdmin(req, null, async ({ requestId }) => {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", `未知的设备操作：${action}`);
    });
  }

  return withAdmin(req, permission, async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, reasonSchema);
    const activation = await prisma.activations.findFirst({
      where: { id, organization_id: session.organization.id },
      include: { licenses: true, devices: true },
    });
    if (!activation) throw new ApiError(404, "RESOURCE_NOT_FOUND", "激活记录不存在");

    if (action === "release") {
      if (activation.status !== "active") {
        throw new ApiError(409, "CONFLICT", "只有 active 状态的设备可以解绑");
      }
    }
    if (action === "block" && activation.status !== "active") {
      throw new ApiError(409, "CONFLICT", "只有 active 状态的设备可以禁用");
    }
    if (action === "unblock" && activation.status !== "blocked") {
      throw new ApiError(409, "CONFLICT", "只有 blocked 状态的设备可以恢复");
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${activation.license_id}::uuid FOR UPDATE`;
      const next =
        action === "release" ? "released" : action === "block" ? "blocked" : "active";
      const updated = await tx.activations.update({
        where: { id },
        data: {
          status: next,
          released_at: action === "release" ? now : activation.released_at,
          revoked_at: action === "block" ? now : activation.revoked_at,
          last_seen_at: action === "unblock" ? now : activation.last_seen_at,
          token_version:
            action === "release" || action === "block"
              ? activation.token_version + 1
              : activation.token_version,
        },
      });

      let activationCount = activation.licenses.activation_count;
      if (action === "release" && activation.licenses.refund_activation_on_release) {
        activationCount = Math.max(0, activationCount - 1);
        await tx.licenses.update({
          where: { id: activation.license_id },
          data: { activation_count: activationCount },
        });
      }

      await tx.activation_events.create({
        data: {
          organization_id: session.organization.id,
          activation_id: id,
          event_type: `admin.${action}`,
          actor_type: "admin",
          actor_id: session.user.id,
          request_id: requestId,
          ip,
          details: { reason: body.reason },
        },
      });

      return { status: next, activationCount };
    });

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: `activation.${action}`,
      resourceType: "activation",
      resourceId: id,
      before: { status: activation.status },
      after: { status: result.status, reason: body.reason, activation_count: result.activationCount },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(result, requestId);
  });
}
