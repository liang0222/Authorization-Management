import type { NextRequest } from "next/server";
import { withPublic, bearerToken } from "@/lib/http/public-api";
import { ApiError, okResponse } from "@/lib/http/api";
import { verifyActivationToken } from "@/lib/domain/activation-token";
import { prisma } from "@/lib/db";
import { computeEffectiveState } from "@/lib/domain/effective-status";

/**
 * GET /api/v1/activations/{activation_id}（规格 4.5）：查询当前激活状态。
 *
 * 与 `/entitlements` 的区别：那个只回权限，且在不可用时直接抛错；这个回**完整状态快照**，
 * 即使授权已暂停/到期也返回 200 + `effective_status`，让客户端能区分「网络断了」
 * 和「授权确实失效了」——断网时它读到的是网络错误，而不是 423/410。
 *
 * 幂等性：读操作，天然幂等（规格里标「非幂等」只是为了提醒它不是幂等键覆盖范围）。
 * 令牌里的 `aid` 必须等于路径参数，否则等于允许拿 A 的令牌查 B 的激活。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ activation_id: string }> }) {
  const { activation_id: activationId } = await ctx.params;
  return withPublic(req, async ({ client, requestId }) => {
    const verification = verifyActivationToken(bearerToken(req));
    if (!verification.ok) {
      throw new ApiError(
        401,
        "CLIENT_AUTH_FAILED",
        verification.reason === "expired" ? "访问令牌已过期，请先心跳刷新令牌" : "访问令牌无效",
      );
    }
    const token = verification.payload;
    if (token.pid !== client.productId) {
      throw new ApiError(422, "PRODUCT_MISMATCH", "令牌与客户端标识不匹配");
    }
    if (token.aid !== activationId) {
      throw new ApiError(403, "FORBIDDEN", "令牌只能查询自身所属的激活");
    }

    const activation = await prisma.activations.findFirst({
      where: { id: activationId, organization_id: token.org },
      include: { licenses: { include: { products: true } }, devices: true },
    });
    if (!activation) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "激活记录不存在");
    }

    const license = activation.licenses;
    const activeCount = await prisma.activations.count({
      where: { license_id: license.id, status: "active" },
    });
    const state = computeEffectiveState(
      {
        adminStatus: license.admin_status,
        productStatus: license.products.status,
        startsAt: license.starts_at,
        expiresAt: license.expires_at,
        activationDeadlineAt: license.activation_deadline_at,
        hasActivated: true,
        activeDeviceCount: activeCount,
        maxDevices: license.max_devices,
        activationCount: license.activation_count,
        maxActivationCount: license.max_activation_count,
      },
      new Date(),
    );

    return okResponse(
      {
        activation_id: activation.id,
        license_id: license.id,
        product_id: license.products.id,
        product_code: license.products.code,
        /** 绑定行为的状态：active / released / revoked。 */
        status: activation.status,
        /** 业务有效状态（3.2 的九级优先级结果），与心跳里的同名字段同源。 */
        effective_status: state.status,
        usable: state.usable,
        status_reason: state.reason,
        activated_at: activation.activated_at.toISOString(),
        last_seen_at: activation.last_seen_at.toISOString(),
        released_at: activation.released_at?.toISOString() ?? null,
        expires_at: license.expires_at?.toISOString() ?? null,
        device: {
          device_instance_id: activation.devices.device_instance_id,
          platform: activation.devices.platform,
          device_name: activation.devices.device_name,
          public_key_thumbprint: activation.devices.public_key_thumbprint,
        },
        device_limit: { max: license.max_devices, active: activeCount },
        entitlements_version: license.entitlements_version,
        /** 是否已开放在线离线使用，以及离线文件最长能活多久。 */
        offline: {
          allowed: license.offline_allowed,
          grace_seconds: license.offline_grace_seconds,
        },
      },
      requestId,
    );
  });
}