import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { ApiError, okResponse, readJson, requestMeta, toErrorResponse } from "@/lib/http/api";
import { rateLimit } from "@/lib/http/rate-limit";
import { randomToken, sha256 } from "@/lib/auth/totp";
import { writeAudit } from "@/lib/domain/audit";

const schema = z.object({
  email: z.string().trim().email("邮箱格式不正确"),
});

/**
 * 申请重置密码。
 * 安全约定：无论邮箱是否存在都返回相同结果（防枚举）。
 * 本环境未配置 SMTP，开发模式把重置链接直接回传前端展示；生产必须 DEV_MAIL_SINK=false。
 */
export async function POST(req: NextRequest) {
  const meta = requestMeta(req);
  try {
    const body = await readJson(req, schema);
    const limiter = rateLimit(`forgot:${meta.ip ?? "unknown"}`, 5, 10 * 60_000);
    if (!limiter.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试", {
        retry_after_seconds: limiter.retryAfterSeconds,
      });
    }

    const user = await prisma.users.findFirst({
      where: { email: { equals: body.email, mode: "insensitive" }, status: "active" },
    });

    let devResetUrl: string | null = null;
    if (user) {
      const token = randomToken(32);
      await prisma.password_reset_tokens.create({
        data: {
          user_id: user.id,
          token_hash: sha256(token),
          expires_at: new Date(Date.now() + 30 * 60_000),
        },
      });
      if (config.devMailSink) {
        devResetUrl = `${config.appBaseUrl}/reset-password?token=${token}`;
      }
      const membership = await prisma.organization_memberships.findFirst({
        where: { user_id: user.id, status: "active" },
      });
      if (membership) {
        await writeAudit({
          organizationId: membership.organization_id,
          actorType: "admin",
          actorId: user.id,
          action: "auth.password_reset_request",
          resourceType: "user",
          resourceId: user.id,
          requestId: meta.requestId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    }

    return okResponse(
      {
        submitted: true,
        // 仅开发模式返回；生产为 null，链接由邮件投递
        devResetUrl,
        mailDeliveryConfigured: !config.devMailSink,
      },
      meta.requestId,
    );
  } catch (error) {
    return toErrorResponse(error, meta.requestId);
  }
}
