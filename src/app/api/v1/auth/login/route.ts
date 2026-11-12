import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError, readJson, requestMeta, successBody, toErrorResponse } from "@/lib/http/api";
import { checkRateLimit, recordFailure, resetRateLimit } from "@/lib/http/rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { verifyTotp } from "@/lib/auth/totp";
import { openSecret } from "@/lib/auth/secretbox";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  createSession,
  csrfCookieOptions,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { writeAudit } from "@/lib/domain/audit";
import { observeLoginFailure } from "@/lib/services/security-alerts";

const loginSchema = z.object({
  email: z.string().trim().min(1, "请输入邮箱").email("邮箱格式不正确"),
  password: z.string().min(1, "请输入密码"),
  totp: z.string().trim().optional(),
});

export async function POST(req: NextRequest) {
  const meta = requestMeta(req);
  try {
    const body = await readJson(req, loginSchema);
    // 只对「失败」计数：成功的登录不消耗额度，避免同一出口 IP 的团队被误伤。
    // 两个桶：同 IP + 同邮箱（防单账号爆破）与同 IP（防跨邮箱撞库扫描）。
    const ip = meta.ip ?? "unknown";
    const pairKey = `login:${ip}:${body.email.toLowerCase()}`;
    const ipKey = `login-ip:${ip}`;
    for (const [key, limit] of [[pairKey, 8], [ipKey, 30]] as const) {
      const gate = checkRateLimit(key, limit);
      if (!gate.allowed) {
        // 429 也是失败尝试：只统计 401 的话，攻击者一旦被限流就再也到不了
        // 「10 分钟内失败 10 次」的告警阈值。这里只旁路观察，不改变 429 响应。
        void observeLoginFailure({
          email: body.email,
          ip: meta.ip,
          requestId: meta.requestId,
          userAgent: meta.userAgent,
        });
        throw new ApiError(429, "RATE_LIMITED", "登录尝试过于频繁，请稍后再试", {
          retry_after_seconds: gate.retryAfterSeconds,
        });
      }
    }

    const user = await prisma.users.findFirst({
      where: { email: { equals: body.email, mode: "insensitive" } },
    });
    // 无论用户是否存在都执行一次哈希校验，避免通过响应时间枚举账号
    const passwordOk = await verifyPassword(
      body.password,
      user?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
    );
    if (!user || !passwordOk) {
      recordFailure(pairKey, 8, 5 * 60_000);
      recordFailure(ipKey, 30, 5 * 60_000);
      void observeLoginFailure({
        email: body.email,
        ip: meta.ip,
        requestId: meta.requestId,
        userAgent: meta.userAgent,
      });
      throw new ApiError(401, "CLIENT_AUTH_FAILED", "邮箱或密码不正确");
    }
    if (user.status !== "active") {
      throw new ApiError(403, "FORBIDDEN", "该管理员账号已被停用");
    }
    if (user.mfa_enabled) {
      if (!body.totp) {
        throw new ApiError(401, "MFA_REQUIRED", "该账号已启用两步验证，请输入 6 位动态验证码", {
          mfa_required: true,
        });
      }
      if (!user.mfa_secret_enc) {
        throw new ApiError(500, "INTERNAL_ERROR", "MFA 配置缺失，请联系组织所有者重置");
      }
      if (!verifyTotp(openSecret(user.mfa_secret_enc), body.totp)) {
        throw new ApiError(401, "CLIENT_AUTH_FAILED", "动态验证码不正确或已过期", { mfa_required: true });
      }
    }

    const membership = await prisma.organization_memberships.findFirst({
      where: { user_id: user.id, status: "active" },
      include: { organizations: true, roles: true },
    });
    if (!membership) {
      throw new ApiError(403, "FORBIDDEN", "该账号尚未加入任何组织");
    }
    if (membership.organizations.status !== "active") {
      throw new ApiError(403, "FORBIDDEN", "组织已停用");
    }

    const { token, csrfToken, expiresAt } = await createSession({
      userId: user.id,
      organizationId: membership.organization_id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    // 登录成功清零该账号的失败计数（同 IP 的总量桶保留，用于阻断跨账号扫描）
    resetRateLimit(pairKey);
    await prisma.users.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
    await writeAudit({
      organizationId: membership.organization_id,
      actorType: "admin",
      actorId: user.id,
      action: "auth.login",
      resourceType: "session",
      resourceId: null,
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const response = NextResponse.json(
      successBody(
        {
          user: {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            mfaEnabled: user.mfa_enabled,
          },
          organization: {
            id: membership.organizations.id,
            name: membership.organizations.name,
            slug: membership.organizations.slug,
            timezone: membership.organizations.timezone,
          },
          role: { code: membership.roles.code, name: membership.roles.name },
          csrfToken,
          expiresAt: expiresAt.toISOString(),
        },
        meta.requestId,
      ),
    );
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    response.cookies.set(CSRF_COOKIE, csrfToken, csrfCookieOptions(expiresAt));
    response.headers.set("x-request-id", meta.requestId);
    return response;
  } catch (error) {
    return toErrorResponse(error, meta.requestId);
  }
}
