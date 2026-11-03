import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError, okResponse, readJson, requestMeta, toErrorResponse } from "@/lib/http/api";
import { hashPassword, passwordPolicyIssues } from "@/lib/auth/password";
import { sha256 } from "@/lib/auth/totp";

const schema = z.object({
  token: z.string().min(20, "重置链接无效"),
  password: z.string().min(1, "请输入新密码"),
});

export async function POST(req: NextRequest) {
  const meta = requestMeta(req);
  try {
    const body = await readJson(req, schema);
    const issues = passwordPolicyIssues(body.password);
    if (issues.length > 0) {
      throw new ApiError(400, "INVALID_REQUEST", issues.join("；"), {
        fieldErrors: { password: issues.join("；") },
      });
    }

    const record = await prisma.password_reset_tokens.findUnique({
      where: { token_hash: sha256(body.token) },
    });
    if (!record || record.used_at || record.expires_at.getTime() <= Date.now()) {
      throw new ApiError(400, "INVALID_REQUEST", "重置链接无效或已过期，请重新申请");
    }

    const passwordHash = await hashPassword(body.password);
    await prisma.$transaction([
      prisma.users.update({ where: { id: record.user_id }, data: { password_hash: passwordHash } }),
      prisma.password_reset_tokens.update({
        where: { id: record.id },
        data: { used_at: new Date() },
      }),
      // 密码变更后强制所有旧会话下线
      prisma.admin_sessions.updateMany({
        where: { user_id: record.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
      prisma.password_reset_tokens.updateMany({
        where: { user_id: record.user_id, used_at: null },
        data: { used_at: new Date() },
      }),
    ]);

    return okResponse({ reset: true }, meta.requestId);
  } catch (error) {
    return toErrorResponse(error, meta.requestId);
  }
}
