import type { NextRequest } from "next/server";
import { withPublic, bearerToken } from "@/lib/http/public-api";
import { ApiError, okResponse } from "@/lib/http/api";
import { verifyActivationToken } from "@/lib/domain/activation-token";
import { entitlementsFor } from "@/lib/services/activations";

/** GET /api/v1/activations/{activation_id}/entitlements（规格 4.10）。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ activation_id: string }> }) {
  return withPublic(req, async ({ requestId }) => {
    const { activation_id: id } = await ctx.params;
    const verification = verifyActivationToken(bearerToken(req));
    if (!verification.ok) {
      throw new ApiError(401, "CLIENT_AUTH_FAILED", "访问令牌无效或已过期");
    }
    if (verification.payload.aid !== id) {
      throw new ApiError(403, "FORBIDDEN", "令牌不属于该激活记录");
    }
    const result = await entitlementsFor(verification.payload);
    return okResponse(result, requestId);
  });
}
