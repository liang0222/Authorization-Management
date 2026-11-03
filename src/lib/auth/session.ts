import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { bytesEqual, sha256, randomToken } from "@/lib/auth/totp";
import { ROLE_PRESETS } from "@/lib/domain/permissions";
import { config } from "@/lib/config";

export const SESSION_COOKIE = "lic_session";
export const CSRF_COOKIE = "lic_csrf";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  mfaEnabled: boolean;
}

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  settings: Record<string, unknown>;
}

export interface SessionContext {
  sessionId: string;
  user: SessionUser;
  organization: SessionOrganization;
  role: { id: string; code: string; name: string };
  permissions: Set<string>;
  csrfTokenHash: Uint8Array;
  expiresAt: Date;
}

function asBytes(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** 创建会话：数据库只保存 token/csrf 的 SHA-256 摘要。 */
export async function createSession(input: {
  userId: string;
  organizationId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await prisma.admin_sessions.create({
    data: {
      organization_id: input.organizationId,
      user_id: input.userId,
      token_hash: sha256(token),
      csrf_token_hash: sha256(csrfToken),
      ip: input.ip,
      user_agent: input.userAgent,
      expires_at: expiresAt,
    },
  });
  return { token, csrfToken, expiresAt };
}

/** 校验会话；返回权限集合，供每一层做 RBAC 判断。 */
export async function resolveSession(token: string | undefined | null): Promise<SessionContext | null> {
  if (!token) return null;
  const session = await prisma.admin_sessions.findUnique({
    where: { token_hash: sha256(token) },
    include: { users: true, organizations: true },
  });
  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at.getTime() <= Date.now()) return null;
  if (session.users.status !== "active") return null;
  if (session.organizations.status !== "active") return null;

  const membership = await prisma.organization_memberships.findFirst({
    where: {
      organization_id: session.organization_id,
      user_id: session.user_id,
      status: "active",
    },
    include: { roles: true },
  });
  if (!membership) return null;

  const roleRows = await prisma.role_permissions.findMany({
    where: { role_id: membership.role_id },
    select: { permission_code: true },
  });
  const permissions = new Set(roleRows.map((row) => row.permission_code));
  if (permissions.size === 0) {
    // 兜底：自定义角色没有显式权限记录时，按系统预设匹配
    const preset = ROLE_PRESETS.find((item) => item.code === membership.roles.code);
    preset?.permissions.forEach((code) => permissions.add(code));
  }

  return {
    sessionId: session.id,
    user: {
      id: session.users.id,
      email: session.users.email,
      displayName: session.users.display_name,
      mfaEnabled: session.users.mfa_enabled,
    },
    organization: {
      id: session.organizations.id,
      name: session.organizations.name,
      slug: session.organizations.slug,
      timezone: session.organizations.timezone,
      settings: (session.organizations.settings ?? {}) as Record<string, unknown>,
    },
    role: {
      id: membership.roles.id,
      code: membership.roles.code,
      name: membership.roles.name,
    },
    permissions,
    csrfTokenHash: asBytes(session.csrf_token_hash),
    expiresAt: session.expires_at,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.admin_sessions.update({
    where: { id: sessionId },
    data: { revoked_at: new Date() },
  }).catch(() => undefined);
}

/** CSRF 双提交校验：Header 必须与 Cookie 一致，且与数据库摘要匹配。 */
export function verifyCsrf(req: NextRequest, session: SessionContext): boolean {
  const header = req.headers.get("x-csrf-token");
  const cookie = req.cookies.get(CSRF_COOKIE)?.value;
  if (!header || !cookie) return false;
  if (header !== cookie) return false;
  return bytesEqual(session.csrfTokenHash, sha256(header));
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // 是否加 Secure 取决于站点协议，而不是 NODE_ENV：
    // 内网用 http 自托管的生产部署也必须能登录，HTTPS 部署则强制 Secure。
    secure: config.appBaseUrl.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  };
}

export function csrfCookieOptions(expiresAt: Date) {
  return {
    httpOnly: false, // 前端需要读取后放进 X-CSRF-Token
    sameSite: "lax" as const,
    secure: config.appBaseUrl.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  };
}
