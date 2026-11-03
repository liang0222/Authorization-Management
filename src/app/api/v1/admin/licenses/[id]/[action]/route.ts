import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { withAdmin, assertPermission, type AdminScope } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import {
  cancelLicense,
  renewLicense,
  resetActivationCount,
  resumeLicense,
  revokeLicense,
  rekeyLicense,
  suspendLicense,
  type ActorContext,
} from "@/lib/services/licenses";
import {
  generateLicenseKey,
  hashLicenseKey,
  licenseKeyLast4,
  licenseKeyPrefix,
} from "@/lib/domain/license-key";
import { writeAudit } from "@/lib/domain/audit";

const durationSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("day"), value: z.number().int().min(1).max(3650) }),
  z.object({ unit: z.literal("month"), value: z.number().int().min(1).max(120) }),
]);

function actorFrom(scope: AdminScope): ActorContext {
  return {
    organizationId: scope.session.organization.id,
    actorId: scope.session.user.id,
    requestId: scope.requestId,
    ip: scope.ip,
    userAgent: scope.userAgent,
  };
}

/** 发放流程：草稿 → 待激活，同时生成第一枚兑换码。 */
async function publishDraft(scope: AdminScope, licenseId: string) {
  const license = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: scope.session.organization.id },
  });
  if (!license) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  if (license.admin_status !== "draft") {
    throw new ApiError(409, "CONFLICT", "只有草稿状态的授权需要发布");
  }
  const key = generateLicenseKey();
  await prisma.$transaction(async (tx) => {
    await tx.licenses.update({ where: { id: licenseId }, data: { admin_status: "pending" } });
    await tx.license_keys.create({
      data: {
        organization_id: scope.session.organization.id,
        license_id: licenseId,
        key_prefix: licenseKeyPrefix(key),
        key_last4: licenseKeyLast4(key),
        key_hash: hashLicenseKey(key),
        hash_key_version: config.licenseHmacPepperVersion,
      },
    });
  });
  await writeAudit({
    organizationId: scope.session.organization.id,
    actorType: "admin",
    actorId: scope.session.user.id,
    action: "license.publish",
    resourceType: "license",
    resourceId: licenseId,
    before: { admin_status: "draft" },
    after: { admin_status: "pending", key_last4: licenseKeyLast4(key) },
    requestId: scope.requestId,
    ip: scope.ip,
    userAgent: scope.userAgent,
  });
  return { licenseKey: key, adminStatus: "pending" as const };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;

  const permissionByAction: Record<string, string> = {
    suspend: "license:suspend",
    resume: "license:suspend",
    revoke: "license:revoke",
    cancel: "license:revoke",
    renew: "license:renew",
    rekey: "license:rekey",
    "reset-activation-count": "license:rekey",
    publish: "license:issue",
  };
  const permission = permissionByAction[action];
  if (!permission) {
    return withAdmin(req, null, async ({ requestId }) => {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", `未知的授权操作：${action}`);
    });
  }

  return withAdmin(req, permission, async (scope) => {
    assertPermission(scope.session, permission);
    const actor = actorFrom(scope);

    switch (action) {
      case "suspend": {
        const body = await readJson(req, z.object({ reason: z.string().max(500).nullish() }));
        const updated = await suspendLicense(actor, id, body.reason ?? null);
        return okResponse({ adminStatus: updated.admin_status }, scope.requestId);
      }
      case "resume": {
        const updated = await resumeLicense(actor, id);
        return okResponse({ adminStatus: updated.admin_status }, scope.requestId);
      }
      case "revoke": {
        const body = await readJson(
          req,
          z.object({ reason: z.string().trim().min(2, "请填写撤销原因").max(500) }),
        );
        const updated = await revokeLicense(actor, id, body.reason);
        return okResponse({ adminStatus: updated.admin_status }, scope.requestId);
      }
      case "cancel": {
        const body = await readJson(req, z.object({ reason: z.string().max(500).nullish() }));
        const updated = await cancelLicense(actor, id, body.reason ?? null);
        return okResponse({ adminStatus: updated.admin_status }, scope.requestId);
      }
      case "renew": {
        const body = await readJson(
          req,
          z.object({
            duration: durationSchema,
            fromNow: z.boolean().optional(),
            paymentRef: z.string().max(160).nullish(),
            notes: z.string().max(1000).nullish(),
          }),
        );
        const result = await renewLicense(actor, id, body.duration, {
          fromNow: body.fromNow,
          paymentRef: body.paymentRef ?? null,
          notes: body.notes ?? null,
        });
        return okResponse(
          {
            previousExpiresAt: result.previousExpiresAt?.toISOString() ?? null,
            newExpiresAt: result.newExpiresAt?.toISOString() ?? null,
            renewalStartsAt: result.renewalStartsAt.toISOString(),
            mode: result.mode,
          },
          scope.requestId,
        );
      }
      case "rekey": {
        const result = await rekeyLicense(actor, id);
        return okResponse(
          { ...result, keyNotice: "新兑换码仅显示一次，旧兑换码已立即失效" },
          scope.requestId,
        );
      }
      case "reset-activation-count": {
        const body = await readJson(
          req,
          z.object({ reason: z.string().trim().min(2, "请填写重置原因").max(500) }),
        );
        const result = await resetActivationCount(actor, id, body.reason);
        return okResponse(result, scope.requestId);
      }
      case "publish": {
        const result = await publishDraft(scope, id);
        return okResponse(result, scope.requestId);
      }
      default:
        throw new ApiError(404, "RESOURCE_NOT_FOUND", `未知的授权操作：${action}`);
    }
  });
}
