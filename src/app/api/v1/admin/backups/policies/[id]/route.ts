import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";
import { isCronLike, policyPatchSchema } from "@/lib/services/backup/schemas";
import { policyDto } from "@/lib/services/backup/serialize";

/** 单个备份策略：读取 / 修改 / 删除。 */

const INCLUDE_TARGETS = {
  backup_policy_targets: {
    include: { backup_storage_destinations: { select: { name: true, provider_type: true } } },
    orderBy: { priority: "asc" as const },
  },
} as const;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const { id } = await ctx.params;
    const row = await prisma.backup_policies.findFirst({
      where: { id, organization_id: session.organization.id },
      include: INCLUDE_TARGETS,
    });
    if (!row) throw new ApiError(404, "NOT_FOUND", "备份策略不存在");
    return okResponse(policyDto(row), requestId);
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const current = await prisma.backup_policies.findFirst({
      where: { id, organization_id: session.organization.id },
      include: INCLUDE_TARGETS,
    });
    if (!current) throw new ApiError(404, "NOT_FOUND", "备份策略不存在");

    const body = await readJson(req, policyPatchSchema);

    if (body.scheduleCron !== undefined && !isCronLike(body.scheduleCron)) {
      throw new ApiError(400, "INVALID_REQUEST", "scheduleCron 需要 5 段 cron 表达式，例如 0 3 * * *", { field: "scheduleCron" });
    }

    const mode = body.targetMode ?? current.target_mode;
    if (mode === "quorum") {
      const targetCount = body.targets?.length ?? current.backup_policy_targets.length;
      const required = body.requiredSuccessCount ?? current.required_success_count ?? 0;
      if (required < 1 || required > targetCount) {
        throw new ApiError(400, "INVALID_REQUEST", `quorum 模式需要 1 到 ${targetCount} 之间的 requiredSuccessCount`, {
          field: "requiredSuccessCount",
        });
      }
    }

    if (body.targets) {
      const ids = body.targets.map((item) => item.destinationId);
      const found = await prisma.backup_storage_destinations.findMany({
        where: { id: { in: ids }, organization_id: session.organization.id },
        select: { id: true, name: true, enabled: true },
      });
      if (found.length !== ids.length) throw new ApiError(400, "INVALID_REQUEST", "策略里有不存在或不属于当前组织的存储目标");
      const disabled = found.filter((item) => !item.enabled);
      if (disabled.length > 0) {
        throw new ApiError(400, "DESTINATION_DISABLED", `以下目标已禁用，不能加入策略：${disabled.map((item) => item.name).join("、")}`);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.scheduleCron !== undefined) patch.schedule_cron = body.scheduleCron;
      if (body.timezone !== undefined) patch.timezone = body.timezone;
      if (body.targetMode !== undefined) patch.target_mode = body.targetMode;
      if (body.requiredSuccessCount !== undefined) patch.required_success_count = body.requiredSuccessCount;
      if (body.retention !== undefined) patch.retention_json = body.retention;
      if (body.verifyMode !== undefined) patch.verify_mode = body.verifyMode;
      if (body.bandwidthLimitKbps !== undefined) patch.bandwidth_limit_kbps = body.bandwidthLimitKbps;
      if (body.parallelism !== undefined) patch.parallelism = body.parallelism;
      if (body.encrypt !== undefined) patch.encrypt = body.encrypt;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.targetMode !== undefined && body.targetMode !== "quorum") patch.required_success_count = null;
      if (Object.keys(patch).length > 0) {
        await tx.backup_policies.update({ where: { id: current.id }, data: patch });
      }

      if (body.targets) {
        await tx.backup_policy_targets.deleteMany({ where: { policy_id: current.id } });
        await tx.backup_policy_targets.createMany({
          data: body.targets.map((item, index) => ({
            organization_id: session.organization.id,
            policy_id: current.id,
            destination_id: item.destinationId,
            priority: item.priority ?? (index + 1) * 10,
            is_required: item.isRequired ?? true,
          })),
        });
      }

      return tx.backup_policies.findUniqueOrThrow({ where: { id: current.id }, include: INCLUDE_TARGETS });
    });

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "backup.policy_update",
      resourceType: "backup_policy",
      resourceId: current.id,
      before: { name: current.name, target_mode: current.target_mode, enabled: current.enabled },
      after: { name: updated.name, target_mode: updated.target_mode, enabled: updated.enabled, targets: updated.backup_policy_targets.length },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(policyDto(updated), requestId);
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const current = await prisma.backup_policies.findFirst({
      where: { id, organization_id: session.organization.id },
    });
    if (!current) throw new ApiError(404, "NOT_FOUND", "备份策略不存在");

    // 历史的备份作业会保留（policy_id 会被置空），但审计里记下「删掉的是哪条策略」。
    await prisma.$transaction(async (tx) => {
      await tx.backup_jobs.updateMany({ where: { policy_id: current.id }, data: { policy_id: null } });
      await tx.backup_policies.delete({ where: { id: current.id } });
    });

    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "backup.policy_delete",
      resourceType: "backup_policy",
      resourceId: current.id,
      before: { name: current.name, schedule_cron: current.schedule_cron },
      requestId,
      ip,
      userAgent,
    });

    return okResponse({ deleted: true }, requestId);
  });
}
