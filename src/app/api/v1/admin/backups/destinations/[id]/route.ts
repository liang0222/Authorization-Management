import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { createCredential, revokeCredential } from "@/lib/services/backup/credentials";
import { destinationPatchSchema, requireFieldsForProvider } from "@/lib/services/backup/schemas";
import { destinationRowDto } from "@/lib/services/backup/serialize";
import { evaluateInsecureHttpTarget } from "@/lib/services/backup/insecure-http";
import { config } from "@/lib/config";

/**
 * 单个存储目标：读取、修改、删除（规格 16.11.2 / 16.11.8）。
 *
 * 两条保护：
 * - 换凭证不原地覆盖，而是吊销旧的、写入新的（保留轮换历史，出问题可回溯）；
 * - 删除前检查引用：被备份策略引用时拒绝，只能先禁用 —— 否则策略会静默少一个目标，
 *   下一次备份「成功」却少了异地副本，这种静默降级比报错危险得多。
 */

const INCLUDE_CREDENTIAL = {
  backup_storage_credentials_backup_storage_credentials_destination_idTobackup_storage_destinations: {
    where: { revoked_at: null },
    select: { id: true },
    take: 1,
  },
} as const;

async function mustFind(organizationId: string, id: string) {
  const row = await prisma.backup_storage_destinations.findFirst({
    where: { id, organization_id: organizationId },
    include: INCLUDE_CREDENTIAL,
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "存储目标不存在");
  return row;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const row = await mustFind(session.organization.id, id);
    return okResponse(destinationRowDto(row), requestId);
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const current = await mustFind(session.organization.id, id);
    const body = await readJson(req, destinationPatchSchema);

    const providerType = body.providerType ?? current.provider_type;
    const endpointUrl = body.endpointUrl === undefined ? current.endpoint_url : body.endpointUrl;
    const bucket = body.bucket === undefined ? current.bucket : body.bucket;
    const hasCredential =
      Boolean(body.credential) ||
      current.backup_storage_credentials_backup_storage_credentials_destination_idTobackup_storage_destinations.length > 0;

    const missing = requireFieldsForProvider({
      providerType,
      endpointUrl,
      bucket,
      authMethod: body.authMethod ?? current.auth_method,
      hasCredential,
      credentialKind: body.credential?.kind ?? null,
    });
    if (missing) throw new ApiError(400, "INVALID_REQUEST", missing, { field: "credential" });

    // 明文 http 的双重确认（阶段 4）：用「改完之后的值」判定，
    // 否则把 https 目标改成 http、或把 tlsVerify 从 true 改成 false 都会绕过创建时的检查。
    const insecureGuard = evaluateInsecureHttpTarget({
      deploymentEnv: config.deploymentEnv,
      endpointUrl,
      tlsVerify: body.tlsVerify === undefined ? current.tls_verify : body.tlsVerify,
    });
    if (!insecureGuard.allowed) {
      throw new ApiError(400, "INSECURE_HTTP_NOT_CONFIRMED", insecureGuard.reason ?? "明文 http 备份目标未完成双重确认", {
        field: "tlsVerify",
        host: insecureGuard.host,
        requires: ["tlsVerify=false", "ALLOW_INSECURE_BACKUP_HTTP=true"],
      });
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (body.credential) {
          if (current.credential_id) await revokeCredential(tx, current.credential_id);
          const created = await createCredential(tx, {
            organizationId: session.organization.id,
            destinationId: current.id,
            payload: body.credential,
          });
          await tx.backup_storage_destinations.update({
            where: { id: current.id },
            data: { credential_id: created.id },
          });
        }

        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.providerType !== undefined) patch.provider_type = body.providerType;
        if (body.adapterType !== undefined) patch.adapter_type = body.adapterType;
        if (body.endpointUrl !== undefined) patch.endpoint_url = body.endpointUrl;
        if (body.region !== undefined) patch.region = body.region;
        if (body.bucket !== undefined) patch.bucket = body.bucket;
        if (body.rootPath !== undefined) patch.root_path = body.rootPath;
        if (body.remotePrefix !== undefined) patch.remote_prefix = body.remotePrefix;
        if (body.authMethod !== undefined) patch.auth_method = body.authMethod;
        if (body.tlsVerify !== undefined) patch.tls_verify = body.tlsVerify;
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        if (body.priority !== undefined) patch.priority = body.priority;
        if (body.isRequired !== undefined) patch.is_required = body.isRequired;
        // 改了连接参数就意味着上一次测试结论作废，必须重新测。
        if (Object.keys(patch).length > 0) {
          patch.last_test_status = "untested";
          patch.last_test_error_code = null;
          patch.last_test_error = null;
          await tx.backup_storage_destinations.update({ where: { id: current.id }, data: patch });
        }

        return tx.backup_storage_destinations.findUniqueOrThrow({
          where: { id: current.id },
          include: INCLUDE_CREDENTIAL,
        });
      });

      if (insecureGuard.needsAudit) {
        await writeAudit({
          organizationId: session.organization.id,
          actorType: "admin",
          actorId: session.user.id,
          action: "backup.target_insecure_accepted",
          resourceType: "backup_storage_destination",
          resourceId: current.id,
          before: { host: current.endpoint_url ? new URL(current.endpoint_url).hostname : null, tls_verify: current.tls_verify },
          after: {
            host: insecureGuard.host,
            provider_type: updated.provider_type,
            tls_verify: updated.tls_verify,
            confirmed_by: "ALLOW_INSECURE_BACKUP_HTTP=true",
          },
          requestId,
          ip,
          userAgent,
        });
      }

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "backup.destination_update",
        resourceType: "backup_storage_destination",
        resourceId: current.id,
        before: { name: current.name, enabled: current.enabled, provider_type: current.provider_type },
        after: { name: updated.name, enabled: updated.enabled, credential_rotated: Boolean(body.credential) },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(destinationRowDto(updated), requestId);
    } catch (error) {
      throw translatePrismaError(error, "存储目标更新失败");
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const current = await mustFind(session.organization.id, id);

    const policyRefs = await prisma.backup_policy_targets.count({
      where: { destination_id: current.id, organization_id: session.organization.id },
    });
    if (policyRefs > 0) {
      throw new ApiError(409, "DESTINATION_IN_USE", "该目标仍被备份策略引用，请先从策略里移除，或改为禁用");
    }

    // 历史作业记录指向这个目标（外键不可空），删除目标时一并清理，但把数量写进审计。
    const historyRows = await prisma.backup_job_targets.count({
      where: { destination_id: current.id, organization_id: session.organization.id },
    });

    await prisma.$transaction(async (tx) => {
      await tx.backup_job_targets.deleteMany({
        where: { destination_id: current.id, organization_id: session.organization.id },
      });
      await tx.backup_storage_destinations.delete({ where: { id: current.id } });
    });

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "backup.destination_delete",
      resourceType: "backup_storage_destination",
      resourceId: current.id,
      before: { name: current.name, provider_type: current.provider_type, removed_job_targets: historyRows },
      requestId,
      ip,
      userAgent,
    });

    return okResponse({ deleted: true, removedJobTargets: historyRows }, requestId);
  });
}
