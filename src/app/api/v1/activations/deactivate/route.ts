import type { NextRequest } from "next/server";
import { z } from "zod";
import { withPublic, withIdempotency, bearerToken } from "@/lib/http/public-api";
import { ApiError, okResponse } from "@/lib/http/api";
import { verifyActivationToken } from "@/lib/domain/activation-token";
import { deactivate, deactivateWithRefreshToken } from "@/lib/services/activations";

const schema = z.object({
  activation_id: z.string().uuid().nullish(),
  refresh_token: z.string().min(16).nullish(),
  reason: z.string().max(500).nullish(),
});

/**
 * POST /api/v1/activations/deactivate（规格 4.9）：客户端主动解绑。
 * 同样兼容两条通道：`refresh_token`（v1.5）或 Bearer（v1.4）。
 * 重复解绑是幂等的：已释放的激活不会再写事件，只回同一结果。
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  return withPublic(req, async ({ client, requestId }) => {
    return withIdempotency(req, client, "deactivate", rawBody, async () => {
      let body: z.infer<typeof schema> = {};
      if (rawBody.trim().length > 0) {
        try {
          body = schema.parse(JSON.parse(rawBody));
        } catch {
          throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON");
        }
      }

      if (body.refresh_token) {
        const result = await deactivateWithRefreshToken(body.refresh_token, body.reason ?? null);
        return okResponse(result, requestId);
      }

      const verification = verifyActivationToken(bearerToken(req));
      if (!verification.ok) {
        throw new ApiError(401, "CLIENT_AUTH_FAILED", "访问令牌无效或已过期");
      }
      if (verification.payload.pid !== client.productId) {
        throw new ApiError(422, "PRODUCT_MISMATCH", "令牌与客户端标识不匹配");
      }
      const result = await deactivate(verification.payload, body.reason ?? null);
      return okResponse(result, requestId);
    });
  });
}
