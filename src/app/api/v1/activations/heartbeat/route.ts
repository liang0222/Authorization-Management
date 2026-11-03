import type { NextRequest } from "next/server";
import { z } from "zod";
import { withPublic, bearerToken } from "@/lib/http/public-api";
import { ApiError, okResponse } from "@/lib/http/api";
import { verifyActivationToken } from "@/lib/domain/activation-token";
import { heartbeat, heartbeatWithRefreshToken } from "@/lib/services/activations";

const schema = z.object({
  activation_id: z.string().uuid().nullish(),
  refresh_token: z.string().min(16).nullish(),
  device_proof: z.string().max(4096).nullish(),
  client: z
    .object({
      app_version: z.string().max(80).nullish(),
      sdk_version: z.string().max(80).nullish(),
    })
    .nullish(),
});

/**
 * POST /api/v1/activations/heartbeat（规格 4.8）。
 * 两条通道并存：
 * - body 带 `refresh_token`：v1.5 通道，每次心跳轮换 refresh token，旧令牌立即失效。
 * - 只有 `Authorization: Bearer`：v1.4 通道，继续校验 access token 的 token_version。
 * 两者都返回同一套响应字段，老客户端读 `token_expires_at` / `license` 仍然可用。
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  return withPublic(req, async ({ requestId }) => {
    let body: z.infer<typeof schema> = {};
    if (rawBody.trim().length > 0) {
      try {
        body = schema.parse(JSON.parse(rawBody));
      } catch {
        throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON");
      }
    }

    if (body.refresh_token) {
      const result = await heartbeatWithRefreshToken(body.refresh_token);
      return okResponse(result, requestId);
    }

    const verification = verifyActivationToken(bearerToken(req));
    if (!verification.ok) {
      throw new ApiError(
        401,
        "CLIENT_AUTH_FAILED",
        verification.reason === "expired" ? "访问令牌已过期，请重新激活或刷新令牌" : "访问令牌无效",
      );
    }
    const result = await heartbeat(verification.payload);
    return okResponse(result, requestId);
  });
}
