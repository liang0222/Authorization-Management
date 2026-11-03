import type { NextRequest } from "next/server";
import { z } from "zod";
import { withPublic, withIdempotency, bearerToken } from "@/lib/http/public-api";
import { ApiError, apiError, okResponse } from "@/lib/http/api";
import { verifyActivationToken } from "@/lib/domain/activation-token";
import {
  canonicalJson,
  deviceKeyThumbprint,
  loadActiveSigningKey,
  loadPrivateKey,
  signBytes,
  spkiDerToRaw,
} from "@/lib/domain/signing-key";
import { prisma } from "@/lib/db";
import { toPrismaBytes } from "@/lib/auth/totp";
import { computeEffectiveState } from "@/lib/domain/effective-status";
import { writeAudit } from "@/lib/domain/audit";

/**
 * POST /api/v1/offline-grants（规格 4.13）：申请离线授权文件。
 *
 * 三个前置检查，缺一不可：
 * 1. 请求方必须持有有效的 Activation 凭证（Bearer access token，且 `aid` 与查询到的激活一致）；
 * 2. 套餐/授权必须允许离线（`licenses.offline_allowed`），且有正数宽限期；
 * 3. 设备必须一致：令牌里的 `did` 必须等于该激活当前绑定的设备，否则等于给别人的设备发文件。
 *
 * 产出的文件必须能离线自证，所以：
 * - payload 用**确定性序列化**（键排序、无空白）后签名，客户端可重算同一串字节验签；
 * - 必须带 `kid`，否则公钥轮换后老文件再也验不过；
 * - `valid_until` 取「现在 + 宽限期」与「授权到期时间」的较小值，不会越过授权本身。
 *
 * 已知边界（规格也承认）：完全离线的设备无法实时获知撤销，只能靠短有效期收敛风险。
 */

const schema = z.object({
  activation_id: z.string().uuid().nullish(),
  /** 客户端可要求更短的有效期，但不能超过服务端算出的上限。 */
  requested_valid_seconds: z.number().int().positive().max(365 * 24 * 3600).nullish(),
});

export const OFFLINE_GRANT_FORMAT = "license-offline-v1";
/** 宽限期为 0 时不做「默认送几天」的猜测，直接拒绝并说明原因。 */
const MAX_OFFLINE_SECONDS = 90 * 24 * 3600;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  return withPublic(req, async ({ client, requestId, ip }) => {
    return withIdempotency(req, client, "offline-grants", rawBody, async () => {
      let body: z.infer<typeof schema> = {};
      if (rawBody.trim().length > 0) {
        try {
          body = schema.parse(JSON.parse(rawBody));
        } catch {
          throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON");
        }
      }

      const verification = verifyActivationToken(bearerToken(req));
      if (!verification.ok) {
        throw new ApiError(
          401,
          "CLIENT_AUTH_FAILED",
          verification.reason === "expired"
            ? "访问令牌已过期，请先心跳刷新令牌再申请离线授权"
            : "访问令牌无效",
        );
      }
      const payload = verification.payload;
      if (payload.pid !== client.productId) {
        throw new ApiError(422, "PRODUCT_MISMATCH", "令牌与客户端标识不匹配");
      }
      if (body.activation_id && body.activation_id !== payload.aid) {
        throw new ApiError(403, "FORBIDDEN", "令牌只能为自身所属的激活申请离线授权");
      }

      const activation = await prisma.activations.findFirst({
        where: { id: payload.aid, organization_id: payload.org, status: "active" },
        include: { licenses: { include: { products: true } }, devices: true },
      });
      if (!activation) {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "激活记录不存在或已释放");
      }
      // 设备一致性：令牌里的 did 必须就是这条激活绑定的设备。
      if (activation.device_id !== payload.did) {
        throw new ApiError(403, "FORBIDDEN", "令牌与激活绑定的设备不一致");
      }

      const license = activation.licenses;
      const product = license.products;
      if (product.status !== "active") {
        throw new ApiError(403, "PRODUCT_DISABLED", "产品已停用");
      }

      const activeCount = await prisma.activations.count({
        where: { license_id: license.id, status: "active" },
      });
      const state = computeEffectiveState(
        {
          adminStatus: license.admin_status,
          productStatus: product.status,
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
      if (!state.usable) {
        throw apiError(
          state.activationBlockReason ?? "LICENSE_INVALID",
          state.reason,
          { effective_status: state.status },
        );
      }

      // 离线许可：授权级的开关是签发时从套餐快照下来的，这里只看授权本身。
      if (!license.offline_allowed) {
        throw new ApiError(422, "OFFLINE_NOT_ALLOWED", "该授权未开放在线离线使用，不能签发离线文件");
      }
      if (license.offline_grace_seconds <= 0) {
        throw new ApiError(
          422,
          "OFFLINE_NOT_ALLOWED",
          "该授权的离线宽限期为 0，请先在授权或套餐里设置宽限期再申请离线文件",
        );
      }
      if (!activation.devices.public_key) {
        throw new ApiError(422, "DEVICE_KEY_MISSING", "该设备没有登记公钥，无法生成离线文件");
      }

      const now = new Date();
      const graceSeconds = Math.min(license.offline_grace_seconds, MAX_OFFLINE_SECONDS);
      let validSeconds = graceSeconds;
      if (body.requested_valid_seconds) {
        validSeconds = Math.min(body.requested_valid_seconds, graceSeconds);
      }
      let validUntil = new Date(now.getTime() + validSeconds * 1000);
      // 不超过授权到期时间：离线性不能成为绕过到期的口子。
      if (license.expires_at && validUntil > license.expires_at) {
        validUntil = license.expires_at;
      }
      if (validUntil <= now) {
        throw new ApiError(410, "LICENSE_EXPIRED", "授权已到期，无法签发离线文件");
      }

      const key = await loadActiveSigningKey(license.organization_id, product.id);
      const keyRow = await prisma.signing_keys.findUnique({
        where: { id: key.id },
        select: { private_key_ref: true },
      });
      if (!keyRow) {
        throw new ApiError(503, "LICENSE_SERVICE_UNAVAILABLE", "签名密钥记录不存在");
      }
      const privateKey = loadPrivateKey(keyRow.private_key_ref);

      const devicePublicKeyBase64Url = Buffer.from(activation.devices.public_key).toString("base64url");
      const serial = `og_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${Buffer.from(
        crypto.getRandomValues(new Uint8Array(4)),
      ).toString("hex")}`;

      const grant = {
        format: OFFLINE_GRANT_FORMAT,
        kid: key.kid,
        serial,
        product_id: product.id,
        license_id: license.id,
        activation_id: activation.id,
        device_instance_id: activation.devices.device_instance_id,
        device_key_thumbprint: deviceKeyThumbprint(devicePublicKeyBase64Url),
        issued_at: now.toISOString(),
        valid_until: validUntil.toISOString(),
        entitlements_version: license.entitlements_version,
        entitlements: (license.feature_snapshot ?? {}) as Record<string, unknown>,
        effective_status: state.status,
        expires_at: license.expires_at?.toISOString() ?? null,
      };

      // 签名覆盖规范化后的 payload（不含签名本身）。
      const canonical = canonicalJson(grant);
      const signature = signBytes(privateKey, Buffer.from(canonical, "utf8"));
      const payloadHash = Buffer.from(
        await crypto.subtle.digest("SHA-256", Buffer.from(canonical, "utf8")),
      );

      await prisma.offline_grants.create({
        data: {
          organization_id: license.organization_id,
          license_id: license.id,
          activation_id: activation.id,
          signing_key_id: key.id,
          serial,
          issued_at: now,
          valid_until: validUntil,
          payload: { ...grant, canonical } as never,
          payload_hash: toPrismaBytes(payloadHash),
          signature: toPrismaBytes(signature),
        },
      });

      await writeAudit({
        organizationId: license.organization_id,
        actorType: "client",
        actorId: activation.devices.device_instance_id,
        action: "offline_grant.issued",
        resourceType: "offline_grant",
        resourceId: serial,
        after: {
          license_id: license.id,
          activation_id: activation.id,
          kid: key.kid,
          valid_until: validUntil.toISOString(),
        },
        requestId,
        ip,
      });

      return okResponse(
        {
          grant,
          /** 签名覆盖的是 `canonicalJson(grant)`，客户端重算同一串字节即可验签。 */
          signature: signature.toString("base64url"),
          algorithm: "EdDSA",
          signing_key: {
            kid: key.kid,
            /** SPKI DER 的 base64url；只支持裸密钥的平台取 `raw_public_key`。 */
            public_key: key.publicKeyDer.toString("base64url"),
            raw_public_key: spkiDerToRaw(key.publicKeyDer).toString("base64url"),
            algorithm: "EdDSA",
          },
          /** 客户端应把这份文件连同公钥一起缓存，断网时用它校验。 */
          canonical_payload: canonical,
          expires_in_seconds: Math.floor((validUntil.getTime() - now.getTime()) / 1000),
        },
        requestId,
        { status: 201 },
      );
    });
  });
}