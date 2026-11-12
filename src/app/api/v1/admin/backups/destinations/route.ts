import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, ApiError, okResponse, readJson, readListQuery } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { config } from "@/lib/config";
import { createCredential } from "@/lib/services/backup/credentials";
import { destinationCreateSchema, requireFieldsForProvider } from "@/lib/services/backup/schemas";
import { assertBackupEndpointAllowed } from "@/lib/services/backup/target-guard";
import { destinationRowDto } from "@/lib/services/backup/serialize";
import { evaluateInsecureHttpTarget } from "@/lib/services/backup/insecure-http";

/**
 * 存储目标列表与创建（规格 16.11.2 / 16.11.8）。
 *
 * 只接受 P0 的四种协议：local / s3 / webdav / sftp。
 * 其它类型（ftps / smb / 网盘 / rclone_other）在 P1，接口层直接 400 拒绝，
 * 免得界面上出现一个「能填但存了就坏」的选项。
 */

const INCLUDE_CREDENTIAL = {
  backup_storage_credentials_backup_storage_credentials_destination_idTobackup_storage_destinations: {
    where: { revoked_at: null },
    select: { id: true },
    take: 1,
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
      prisma.backup_storage_destinations.findMany({
        where,
        include: INCLUDE_CREDENTIAL,
        orderBy: [{ priority: "asc" }, { created_at: "asc" }],
        skip: query.skip,
        take: query.pageSize,
      }),
      prisma.backup_storage_destinations.count({ where }),
    ]);
    return okResponse(
      {
        items: rows.map(destinationRowDto),
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
    const body = await readJson(req, destinationCreateSchema);

    const missing = requireFieldsForProvider({
      providerType: body.providerType,
      endpointUrl: body.endpointUrl,
      bucket: body.bucket,
      authMethod: body.authMethod,
      hasCredential: Boolean(body.credential),
      credentialKind: body.credential?.kind ?? null,
    });
    if (missing) throw new ApiError(400, "INVALID_REQUEST", missing, { field: "credential" });

    // SSRF：端点地址在入库前就校验，避免「配置能存、备份时才替调用方访问内网」。
    assertBackupEndpointAllowed(
      { providerType: body.providerType, endpointUrl: body.endpointUrl },
      { allowHttpLoopback: config.deploymentEnv !== "production" },
    );

    // 明文 http 的双重确认（阶段 4）：生产环境保存非回环 http 目标时，
    // 目标上的 tls_verify=false 与环境变量 ALLOW_INSECURE_BACKUP_HTTP=true 必须同时具备。
    // 拦在保存阶段而不是等执行时才发现：配置能存进去、备份时才报错，是最难查的一类问题。
    const insecureGuard = evaluateInsecureHttpTarget({
      deploymentEnv: config.deploymentEnv,
      endpointUrl: body.endpointUrl ?? null,
      tlsVerify: body.tlsVerify ?? true,
    });
    if (!insecureGuard.allowed) {
      throw new ApiError(400, "INSECURE_HTTP_NOT_CONFIRMED", insecureGuard.reason ?? "明文 http 备份目标未完成双重确认", {
        field: "tlsVerify",
        host: insecureGuard.host,
        requires: ["tlsVerify=false", "ALLOW_INSECURE_BACKUP_HTTP=true"],
      });
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const destination = await tx.backup_storage_destinations.create({
          data: {
            organization_id: session.organization.id,
            name: body.name,
            provider_type: body.providerType,
            adapter_type: body.adapterType ?? "native",
            endpoint_url: body.endpointUrl ?? null,
            region: body.region ?? null,
            bucket: body.bucket ?? null,
            root_path: body.rootPath ?? null,
            remote_prefix: body.remotePrefix ?? null,
            auth_method: body.authMethod,
            tls_verify: body.tlsVerify ?? true,
            enabled: body.enabled ?? true,
            priority: body.priority ?? 100,
            is_required: body.isRequired ?? true,
          },
        });

        if (body.credential) {
          const credential = await createCredential(tx, {
            organizationId: session.organization.id,
            destinationId: destination.id,
            payload: body.credential,
          });
          await tx.backup_storage_destinations.update({
            where: { id: destination.id },
            data: { credential_id: credential.id },
          });
        }

        return tx.backup_storage_destinations.findUniqueOrThrow({
          where: { id: destination.id },
          include: INCLUDE_CREDENTIAL,
        });
      });

      if (insecureGuard.needsAudit) {
        // 「不合规但被双重确认放行」必须留痕：以后要查「谁允许了这条明文链路」时，
        // 只有这条审计能回答。resource_id 指目标，after 里只写主机，不写任何凭据。
        await writeAudit({
          organizationId: session.organization.id,
          actorType: "admin",
          actorId: session.user.id,
          action: "backup.target_insecure_accepted",
          resourceType: "backup_storage_destination",
          resourceId: created.id,
          after: {
            host: insecureGuard.host,
            provider_type: created.provider_type,
            tls_verify: created.tls_verify,
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
        action: "backup.destination_create",
        resourceType: "backup_storage_destination",
        resourceId: created.id,
        after: { name: created.name, provider_type: created.provider_type, credential: Boolean(body.credential) },
        requestId,
        ip,
        userAgent,
      });

      return okResponse(destinationRowDto(created), requestId, { status: 201 });
    } catch (error) {
      throw translatePrismaError(error, "存储目标创建失败");
    }
  });
}
