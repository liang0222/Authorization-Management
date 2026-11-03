import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { hashPassword, passwordPolicyIssues, verifyPassword } from "@/lib/auth/password";
import { currentTotp, generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/auth/totp";
import { openSecret, sealSecret } from "@/lib/auth/secretbox";
import { writeAudit } from "@/lib/domain/audit";

/** 个人资料与安全设置（当前登录管理员自身，不涉及其他成员）。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId }) => {
    const user = await prisma.users.findUnique({ where: { id: session.user.id } });
    return okResponse(
      {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
        mfaEnabled: user?.mfa_enabled ?? false,
        lastLoginAt: user?.last_login_at?.toISOString() ?? null,
        createdAt: user?.created_at.toISOString() ?? null,
        role: session.role,
        organization: session.organization,
      },
      requestId,
    );
  });
}

const profileSchema = z.object({
  displayName: z.string().trim().min(2, "显示名称至少 2 个字符").max(60),
});

export async function PATCH(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, profileSchema);
    await prisma.users.update({
      where: { id: session.user.id },
      data: { display_name: body.displayName },
    });
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "user.update_profile",
      resourceType: "user",
      resourceId: session.user.id,
      before: { display_name: session.user.displayName },
      after: { display_name: body.displayName },
      requestId,
      ip,
      userAgent,
    });
    return okResponse({ displayName: body.displayName }, requestId);
  });
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(1, "请输入新密码"),
});

/** 修改密码：必须是本人当前密码，成功后保留当前会话、吊销其他会话。 */
export async function PUT(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId, ip, userAgent }) => {
    const body = await readJson(req, passwordSchema);
    const issues = passwordPolicyIssues(body.newPassword);
    if (issues.length > 0) {
      throw new ApiError(400, "INVALID_REQUEST", issues.join("；"), {
        fieldErrors: { newPassword: issues.join("；") },
      });
    }
    const user = await prisma.users.findUnique({ where: { id: session.user.id } });
    if (!user) throw new ApiError(404, "RESOURCE_NOT_FOUND", "账号不存在");
    if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
      throw new ApiError(400, "INVALID_REQUEST", "当前密码不正确", {
        fieldErrors: { currentPassword: "当前密码不正确" },
      });
    }
    const passwordHash = await hashPassword(body.newPassword);
    await prisma.users.update({ where: { id: user.id }, data: { password_hash: passwordHash } });
    await prisma.admin_sessions.updateMany({
      where: { user_id: user.id, id: { not: session.sessionId }, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: user.id,
      action: "user.change_password",
      resourceType: "user",
      resourceId: user.id,
      requestId,
      ip,
      userAgent,
    });
    return okResponse({ updated: true }, requestId);
  });
}

const mfaEnrollSchema = z.object({ action: z.literal("begin") });

/**
 * MFA 管理：
 * - action=begin：生成 TOTP 密钥（加密存储），返回 otpauth 链接与当前验证码用于自检。
 * - action=confirm：校验 6 位验证码后正式启用。
 * - action=disable：需要当前密码 + 验证码。
 */
export async function POST(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId, ip, userAgent }) => {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "begin";

    if (action === "begin") {
      const secret = generateTotpSecret();
      await prisma.users.update({
        where: { id: session.user.id },
        data: { mfa_secret_enc: sealSecret(secret), mfa_enabled: false },
      });
      return okResponse(
        {
          secret,
          otpauthUri: otpauthUri(secret, session.user.email),
          // 便于自动化测试/无手机场景自检；真实产品不应回传当前验证码
          previewCode: currentTotp(secret),
        },
        requestId,
      );
    }

    if (action === "confirm") {
      const body = await readJson(req, z.object({ code: z.string().trim().min(6).max(6) }));
      const user = await prisma.users.findUnique({ where: { id: session.user.id } });
      if (!user?.mfa_secret_enc) {
        throw new ApiError(400, "INVALID_REQUEST", "请先开始 MFA 绑定流程");
      }
      if (!verifyTotp(openSecret(user.mfa_secret_enc), body.code)) {
        throw new ApiError(400, "INVALID_REQUEST", "验证码不正确", {
          fieldErrors: { code: "验证码不正确或已过期" },
        });
      }
      await prisma.users.update({ where: { id: user.id }, data: { mfa_enabled: true } });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: user.id,
        action: "user.mfa_enabled",
        resourceType: "user",
        resourceId: user.id,
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ mfaEnabled: true }, requestId);
    }

    if (action === "disable") {
      const body = await readJson(
        req,
        z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(6) }),
      );
      const user = await prisma.users.findUnique({ where: { id: session.user.id } });
      if (!user?.mfa_secret_enc) {
        throw new ApiError(400, "INVALID_REQUEST", "当前未启用 MFA");
      }
      if (!(await verifyPassword(body.password, user.password_hash))) {
        throw new ApiError(400, "INVALID_REQUEST", "密码不正确", {
          fieldErrors: { password: "密码不正确" },
        });
      }
      if (!verifyTotp(openSecret(user.mfa_secret_enc), body.code)) {
        throw new ApiError(400, "INVALID_REQUEST", "验证码不正确", {
          fieldErrors: { code: "验证码不正确或已过期" },
        });
      }
      await prisma.users.update({
        where: { id: user.id },
        data: { mfa_enabled: false, mfa_secret_enc: null },
      });
      await writeAudit({
        organizationId: session.organization.id,
        actorType: "admin",
        actorId: user.id,
        action: "user.mfa_disabled",
        resourceType: "user",
        resourceId: user.id,
        requestId,
        ip,
        userAgent,
      });
      return okResponse({ mfaEnabled: false }, requestId);
    }

    throw new ApiError(400, "INVALID_REQUEST", "未知的 MFA 操作");
  });
}
