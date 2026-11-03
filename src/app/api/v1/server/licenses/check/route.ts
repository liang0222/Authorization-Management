import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { withServerAssertion } from "@/lib/http/server-api";
import { prisma } from "@/lib/db";
import { toPrismaBytes } from "@/lib/auth/totp";
import { computeEffectiveState } from "@/lib/domain/effective-status";

const schema = z.object({
  product_id: z.string().uuid().nullish(),
  identity: z.object({
    provider: z.enum(["wechat_mini_program", "google", "microsoft", "email", "phone", "custom"]),
    subject_token: z.string().min(3).max(512),
  }),
  required_features: z.array(z.string().min(1).max(80)).max(64).default([]),
});

/**
 * POST /api/v1/server/licenses/check（规格 4.12）。
 *
 * 给「网站后端 / 小程序后端」这类可信服务端用的授权检查：
 * - 认证靠 private_key_jwt 断言（见 `authenticateServerAssertion`），不认 X-Client-ID。
 * - 入参的 `identity.subject_token` 是调用方后端已经验证过的用户标识，
 *   服务端只做 `sha256(subject_token)` 后与 `customer_identities` 比对，不保存明文。
 * - 返回授权是否覆盖所需功能；缺哪些功能写在 `missing_features`，便于调用方降级。
 */
export async function POST(req: NextRequest) {
  return withServerAssertion(req, async ({ identity: server, requestId }) => {
    const body = await readJson(req, schema);

    if (body.product_id && body.product_id !== server.productId) {
      throw new ApiError(422, "PRODUCT_MISMATCH", "product_id 与凭证所属产品不一致");
    }

    const subjectHash = toPrismaBytes(
      createHash("sha256").update(body.identity.subject_token, "utf8").digest(),
    );
    const binding = await prisma.customer_identities.findFirst({
      where: {
        organization_id: server.organizationId,
        product_id: server.productId,
        provider: body.identity.provider,
        subject_hash: subjectHash,
      },
      select: { customer_id: true, status: true },
    });

    if (!binding || binding.status !== "active") {
      // 不区分「没绑定」和「绑定被停用」：两种情况对调用方都是「这个用户没有授权」。
      return okResponse(
        {
          authorized: false,
          effective_status: null,
          license_id: null,
          expires_at: null,
          entitlements_version: null,
          entitlements: {},
          missing_features: body.required_features,
        },
        requestId,
      );
    }

    const candidates = await prisma.licenses.findMany({
      where: {
        organization_id: server.organizationId,
        product_id: server.productId,
        customer_id: binding.customer_id,
        admin_status: { in: ["active", "suspended"] },
      },
      include: { products: true },
      orderBy: { expires_at: { sort: "desc", nulls: "first" } },
      take: 20,
    });

    const now = new Date();
    let best:
      | {
          id: string;
          status: string;
          expiresAt: Date | null;
          version: number;
          entitlements: Record<string, unknown>;
          expiresScore: number;
        }
      | null = null;

    for (const license of candidates) {
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
          hasActivated: license.activation_count > 0 || license.starts_at !== null,
          activeDeviceCount: activeCount,
          maxDevices: license.max_devices,
          activationCount: license.activation_count,
          maxActivationCount: license.max_activation_count,
        },
        now,
      );
      if (!state.usable) continue;
      // 同一客户可能有多份授权：优先长期有效（永久 > 到期最晚）。
      const score = license.expires_at ? license.expires_at.getTime() : Number.MAX_SAFE_INTEGER;
      if (!best || score > best.expiresScore) {
        best = {
          id: license.id,
          status: state.status,
          expiresAt: license.expires_at,
          version: license.entitlements_version,
          entitlements: (license.feature_snapshot ?? {}) as Record<string, unknown>,
          expiresScore: score,
        };
      }
    }

    if (!best) {
      return okResponse(
        {
          authorized: false,
          effective_status: null,
          license_id: null,
          expires_at: null,
          entitlements_version: null,
          entitlements: {},
          missing_features: body.required_features,
        },
        requestId,
      );
    }

    const missing = body.required_features.filter((feature) => {
      const value = best!.entitlements[feature];
      // 布尔直接看真假；数字/字符串只有存在即视为具备（具体阈值由调用方解释）。
      if (typeof value === "boolean") return !value;
      return value === undefined || value === null || value === false;
    });

    return okResponse(
      {
        authorized: missing.length === 0,
        effective_status: best.status,
        license_id: best.id,
        expires_at: best.expiresAt?.toISOString() ?? null,
        entitlements_version: best.version,
        entitlements: best.entitlements,
        missing_features: missing,
      },
      requestId,
    );
  });
}
