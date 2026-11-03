import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { isCronLike, policyCreateSchema } from "@/lib/services/backup/schemas";
import { policyDto } from "@/lib/services/backup/serialize";

/**
 * 备份策略（规格 16.11.3 / 16.11.8）。
 *
 * 策略决定四件事：什么时候备、备到哪几个目标、多目标怎么算成功、留多久。
 * `target_mode` 是这里最容易被忽略又最影响结果的字段：
 * - all_required（默认）：全部必需目标都成功才算成功，适合「必须有异地副本」的合规场景；
 * - primary_then_fallback：主目标失败但备用成功时标 degraded 并告警，绝不假装主目标成功；
 * - quorum：达到 required_success_count 就算 partial，适合目标多、容忍个别故障的场景。
 */

const INCLUDE_TARGETS = {
  backup_policy_targets: {
    include: { backup_storage_destinations: { select: { name: true, provider_type: true } } },
    orderBy: { priority: "asc" as const },
  },
} as const;

export async function GET(req: NextRequest) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const query = readListQuery(req.nextUrl, 50);
    const where = {
      organization_id: session.organization.id,
      ...(query.q ? { name: { contains: query.q, mode: "insensitive" as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.backup_policies.findMany({
        where,
        include: INCLUDE_TARGETS,
        orderBy: { created_at: "asc" },
        skip: query.skip,
        take: query.pageSize,
      }),
      prisma.backup_policies.count({ where }),
    ]);
    return okResponse(
      {
        items: rows.map(policyDto),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
      },
      requestId,
    );
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(req, "backup:write", async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, policyCreateSchema);

    const cron = body.scheduleCron ?? "0 3 * * *";
    if (!isCronLike(cron)) throw new ApiError(400, "INVALID_REQUEST", "scheduleCron 需要 5 段 cron 表达式，例如 0 3 * * *", { field: "scheduleCron" });

    if (body.targetMode === "quorum") {
      const required = body.requiredSuccessCount ?? 0;
      if (required < 1 || required > body.targets.length) {
        throw new ApiError(400, "INVALID_REQUEST", `quorum 模式需要 1 到 ${body.targets.length} 之间的 requiredSuccessCount`, {
          field: "requiredSuccessCount",
        });
      }
    }

    // 目标必须都属于本组织，且当前可用（禁用目标不能进策略）。
    const destinationIds = body.targets.map((item) => item.destinationId);
    const destinations = await prisma.backup_storage_destinations.findMany({
      where: { id: { in: destinationIds }, organization_id: session.organization.id },
      select: { id: true, name: true, enabled: true },
    });
    if (destinations.length !== destinationIds.length) {
      throw new ApiError(400, "INVALID_REQUEST", "策略里有不存在或不属于当前组织的存储目标");
    }
    const disabled = destinations.filter((item) => !item.enabled);
    if (disabled.length > 0) {
      throw new ApiError(400, "DESTINATION_DISABLED", `以下目标已禁用，不能加入策略：${disabled.map((item) => item.name).join("、")}`);
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const policy = await tx.backup_policies.create({
          data: {
            organization_id: session.organization.id,
            name: body.name,
            schedule_cron: cron,
            timezone: body.timezone ?? session.organization.timezone ?? "UTC",
            target_mode: body.targetMode ?? "all_required",
            required_success_count: body.targetMode === "quorum" ? body.requiredSuccessCount ?? null : null,
            retention_json: (body.retention ?? { daily: 7, weekly: 4, monthly: 6 }) as never,
            verify_mode: body.verifyMode ?? "sha256_and_manifest",
            bandwidth_limit_kbps: body.bandwidthLimitKbps ?? null,
            parallelism: body.parallelism ?? 2,
            encrypt: body.encrypt ?? true,
            enabled: body.enabled ?? true,
          },
        });

        await tx.backup_policy_targets.createMany({
          data: body.targets.map((item, index) => ({
            organization_id: session.organization.id,
            policy_id: policy.id,
            destination_id: item.destinationId,
            priority: item.priority ?? (index + 1) * 10,
            is_required: item.isRequired ?? true,
          })),
        });

        return tx.backup_policies.findUniqueOrThrow({ where: { id: policy.id }, include: INCLUDE_TARGETS });
      });

      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "backup.policy_create",
        resourceType: "backup_policy",
        resourceId: created.id,
        after: { name: created.name, target_mode: created.target_mode, targets: created.backup_policy_targets.length },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(policyDto(created), requestId, { status: 201 });
    } catch (error) {
      throw translatePrismaError(error, "备份策略创建失败");
    }
  });
}
