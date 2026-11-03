import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { getLicenseDetail } from "@/lib/services/license-list";
import { maskLicenseKey } from "@/lib/domain/license-key";
import { writeAudit } from "@/lib/domain/audit";

const patchSchema = z.object({
  notes: z.string().max(2000).nullish(),
  externalOrderId: z.string().max(120).nullish(),
  maxDevices: z.number().int().min(1).max(1000).optional(),
  maxActivationCount: z.number().int().min(1).max(100000).nullish(),
  offlineAllowed: z.boolean().optional(),
  offlineGraceSeconds: z.number().int().min(0).max(31_536_000).optional(),
  activationDeadlineAt: z.string().datetime().nullish(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "license:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const detail = await getLicenseDetail(session.organization.id, id);
    if (!detail) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在或不属于当前组织");
    const { license, effective, activeDevices } = detail;
    const activeKey = license.license_keys.find((key) => key.status === "active") ?? null;

    return okResponse(
      {
        license: {
          id: license.id,
          adminStatus: license.admin_status,
          effective,
          duration: { unit: license.duration_unit, value: license.duration_value },
          startPolicy: license.start_policy,
          timezone: license.timezone,
          startsAt: license.starts_at?.toISOString() ?? null,
          expiresAt: license.expires_at?.toISOString() ?? null,
          activationDeadlineAt: license.activation_deadline_at?.toISOString() ?? null,
          maxDevices: license.max_devices,
          activeDevices,
          maxActivationCount: license.max_activation_count,
          activationCount: license.activation_count,
          maxSubjects: license.max_subjects,
          refundActivationOnRelease: license.refund_activation_on_release,
          offlineAllowed: license.offline_allowed,
          offlineGraceSeconds: license.offline_grace_seconds,
          featureSnapshot: license.feature_snapshot,
          /** 权限快照版本：客户端心跳拿它判断要不要重新拉权限（P1-3）。 */
          entitlementsVersion: license.entitlements_version,
          features: license.license_features.map((row) => ({
            code: row.feature_code,
            value: row.feature_value,
            updatedAt: row.updated_at.toISOString(),
          })),
          notes: license.notes,
          externalOrderId: license.external_order_id,
          createdAt: license.created_at.toISOString(),
          createdBy: license.users,
          product: {
            id: license.products.id,
            name: license.products.name,
            code: license.products.code,
            type: license.products.product_type,
            status: license.products.status,
          },
          customer: {
            id: license.customers.id,
            name: license.customers.name,
            email: license.customers.email,
            company: license.customers.company_name,
          },
          plan: license.plans
            ? { id: license.plans.id, name: license.plans.name, code: license.plans.code }
            : null,
          key: activeKey
            ? {
                id: activeKey.id,
                mask: maskLicenseKey(activeKey.key_last4),
                last4: activeKey.key_last4,
                status: activeKey.status,
                firstRedeemedAt: activeKey.first_redeemed_at?.toISOString() ?? null,
                createdAt: activeKey.created_at.toISOString(),
              }
            : null,
          keys: license.license_keys.map((key) => ({
            id: key.id,
            mask: maskLicenseKey(key.key_last4),
            status: key.status,
            createdAt: key.created_at.toISOString(),
            revokedAt: key.revoked_at?.toISOString() ?? null,
            firstRedeemedAt: key.first_redeemed_at?.toISOString() ?? null,
          })),
        },
        renewals: license.license_renewals.map((row) => ({
          id: row.id,
          duration: { unit: row.duration_unit, value: row.duration_value },
          previousExpiresAt: row.previous_expires_at?.toISOString() ?? null,
          renewalStartsAt: row.renewal_starts_at.toISOString(),
          newExpiresAt: row.new_expires_at?.toISOString() ?? null,
          mode: row.renewal_mode,
          paymentRef: row.external_payment_ref,
          notes: row.notes,
          createdAt: row.created_at.toISOString(),
        })),
        activations: license.activations.map((row) => ({
          id: row.id,
          status: row.status,
          deviceId: row.device_id,
          deviceName: row.devices.device_name,
          platform: row.devices.platform,
          instanceId: row.devices.device_instance_id,
          clientVersion: row.client_version,
          activatedAt: row.activated_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          releasedAt: row.released_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          lastIp: row.last_ip,
        })),
        events: detail.events.map((row) => ({
          id: row.id.toString(),
          activationId: row.activation_id,
          type: row.event_type,
          actorType: row.actor_type,
          createdAt: row.created_at.toISOString(),
          details: row.details,
        })),
        auditLogs: detail.auditLogs.map((row) => ({
          id: row.id.toString(),
          action: row.action,
          actorType: row.actor_type,
          actorId: row.actor_id,
          before: row.before_data,
          after: row.after_data,
          createdAt: row.created_at.toISOString(),
        })),
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "license:issue", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);
    const before = await prisma.licenses.findFirst({
      where: { id, organization_id: session.organization.id },
    });
    if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
    const updated = await prisma.licenses.update({
      where: { id },
      data: {
        notes: body.notes === undefined ? undefined : body.notes,
        external_order_id: body.externalOrderId === undefined ? undefined : body.externalOrderId,
        max_devices: body.maxDevices,
        max_activation_count: body.maxActivationCount === undefined ? undefined : body.maxActivationCount,
        offline_allowed: body.offlineAllowed,
        offline_grace_seconds: body.offlineGraceSeconds,
        activation_deadline_at:
          body.activationDeadlineAt === undefined
            ? undefined
            : body.activationDeadlineAt
              ? new Date(body.activationDeadlineAt)
              : null,
        updated_at: new Date(),
      },
    });
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "license.update",
      resourceType: "license",
      resourceId: id,
      before: {
        max_devices: before.max_devices,
        max_activation_count: before.max_activation_count,
        notes: before.notes,
      },
      after: {
        max_devices: updated.max_devices,
        max_activation_count: updated.max_activation_count,
        notes: updated.notes,
      },
      requestId,
      ip,
      userAgent,
    });
    return okResponse({ updated: true }, requestId);
  });
}
