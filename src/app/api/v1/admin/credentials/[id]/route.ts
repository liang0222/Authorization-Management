import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { translatePrismaError } from "@/lib/http/db-errors";
import { writeAudit } from "@/lib/domain/audit";
import { generateClientSecret } from "@/lib/domain/license-key";

/**
 * 单个产品凭证的运维操作（规格 6.4 的思路同样适用于凭证）：
 * - rotate：只对机密服务端凭证生效，生成新 secret 并立即替换摘要，旧 secret 立刻失效。
 * - disable / enable：只切换可恢复的 status，不删除记录（审计可追溯）。
 * - update：改名称/作用域/来源白名单。
 * 任何响应与审计都不会出现 secret 明文或摘要。
 */

const CREDENTIAL_SCOPES = [
  "license:validate",
  "activation:create",
  "activation:heartbeat",
  "activation:deactivate",
  "entitlements:read",
  "offline:grant",
  "server:check",
  "server:assign",
] as const;

const patchSchema = z
  .object({
    action: z.enum(["rotate", "disable", "enable", "update"]).optional(),
    name: z.string().trim().min(1, "请填写凭证名称").max(120).optional(),
    scopes: z.array(z.enum(CREDENTIAL_SCOPES)).max(CREDENTIAL_SCOPES.length).optional(),
    allowedOrigins: z
      .array(z.string().trim().url("来源地址必须是合法 URL").max(500))
      .max(20)
      .optional(),
  })
  .refine(
    (value) =>
      value.action !== undefined ||
      value.name !== undefined ||
      value.scopes !== undefined ||
      value.allowedOrigins !== undefined,
    { message: "请提供 action 或要更新的字段" },
  );

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "credential:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, patchSchema);
    const credential = await prisma.product_credentials.findFirst({
      // 环境隔离（规格 27.3）：跨环境按「不存在」处理，管理端也点不开对方的凭证。
      where: { id, organization_id: session.organization.id, environment: config.credentialEnvironment },
    });
    if (!credential) throw new ApiError(404, "RESOURCE_NOT_FOUND", "凭证不存在");
    // 归档等价于业务上的删除：保留记录供审计，但不再允许任何变更或继续使用。
    if (credential.status === "archived") {
      throw new ApiError(409, "CONFLICT", "已归档的凭证不可再修改");
    }

    const action = body.action ?? "update";

    if (action === "rotate") {
      if (credential.credential_type !== "confidential_server") {
        throw new ApiError(409, "CONFLICT", "公开客户端凭证没有密钥，无需轮换");
      }
      const clientSecret = generateClientSecret();
      const secretHash = createHash("sha256").update(clientSecret).digest();
      try {
        const rotated = await prisma.product_credentials.update({
          where: { id },
          data: { secret_hash: secretHash, rotated_at: new Date() },
        });
        await writeAudit({
          organizationId: session.organization.id,
          actorType: "admin",
          actorId: session.user.id,
          action: "credential.rotate",
          resourceType: "credential",
          resourceId: id,
          before: { clientId: credential.client_id, rotatedAt: credential.rotated_at?.toISOString() ?? null },
          after: { clientId: rotated.client_id, rotatedAt: rotated.rotated_at?.toISOString() ?? null },
          requestId,
          ip,
          userAgent,
        });
        return okResponse(
          {
            id: rotated.id,
            clientId: rotated.client_id,
            // 新 secret 只在此处出现一次；库里只有它的摘要。
            clientSecret,
            rotatedAt: rotated.rotated_at?.toISOString() ?? null,
            secretNotice: "新的 clientSecret 仅显示一次，旧密钥已立即失效",
          },
          requestId,
        );
      } catch (error) {
        translatePrismaError(error, "凭证密钥轮换失败");
      }
    }

    if (action === "disable" || action === "enable") {
      const nextStatus = action === "disable" ? "disabled" : "active";
      if (credential.status === nextStatus) {
        throw new ApiError(
          409,
          "CONFLICT",
          action === "disable" ? "凭证已处于禁用状态" : "凭证已处于启用状态",
        );
      }
      const updated = await prisma.product_credentials.update({
        where: { id },
        data: { status: nextStatus },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "credential.update",
        resourceType: "credential",
        resourceId: id,
        before: { status: credential.status },
        after: { status: updated.status, clientId: updated.client_id },
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ id, status: updated.status }, requestId);
    }

    // action === "update"：只允许改元数据，凭证类型与 client_id 创建后不可变。
    if (credential.credential_type === "public_client" && (body.allowedOrigins?.length ?? 0) > 0) {
      throw new ApiError(400, "INVALID_REQUEST", "公开客户端凭证不能配置允许来源");
    }
    const nextName = body.name ?? credential.name;
    const nextScopes = body.scopes ? [...body.scopes] : credential.scopes;
    const nextOrigins =
      credential.credential_type === "public_client"
        ? []
        : body.allowedOrigins
          ? [...body.allowedOrigins]
          : credential.allowed_origins;

    try {
      const updated = await prisma.product_credentials.update({
        where: { id },
        data: { name: nextName, scopes: nextScopes, allowed_origins: nextOrigins },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: session.user.id,
        action: "credential.update",
        resourceType: "credential",
        resourceId: id,
        before: {
          name: credential.name,
          scopes: credential.scopes,
          allowedOrigins: credential.allowed_origins,
        },
        after: {
          name: updated.name,
          scopes: updated.scopes,
          allowedOrigins: updated.allowed_origins,
        },
        requestId,
        ip,
        userAgent,
      });
      return okResponse(
        {
          id: updated.id,
          name: updated.name,
          type: updated.credential_type,
          clientId: updated.client_id,
          status: updated.status,
          scopes: updated.scopes,
          allowedOrigins: updated.allowed_origins,
        },
        requestId,
      );
    } catch (error) {
      translatePrismaError(error, "凭证更新失败");
    }
  });
}

/**
 * 软删除：只把 status 置为 archived。
 * 凭证可能已经被客户端缓存，硬删除会让“这个 client_id 为什么失效”无法追溯。
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "credential:write", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const credential = await prisma.product_credentials.findFirst({
      where: { id, organization_id: session.organization.id, environment: config.credentialEnvironment },
      select: { id: true, name: true, client_id: true, status: true },
    });
    if (!credential) throw new ApiError(404, "RESOURCE_NOT_FOUND", "凭证不存在");
    if (credential.status === "archived") {
      throw new ApiError(409, "CONFLICT", "凭证已归档");
    }

    const updated = await prisma.product_credentials.update({
      where: { id },
      data: { status: "archived" },
    });
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "credential.archive",
      resourceType: "credential",
      resourceId: id,
      before: { status: credential.status },
      after: { status: updated.status, clientId: credential.client_id, name: credential.name },
      requestId,
      ip,
      userAgent,
    });

    return okResponse({ id, status: updated.status }, requestId);
  });
}
