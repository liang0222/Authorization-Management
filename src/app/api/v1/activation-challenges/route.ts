import type { NextRequest } from "next/server";
import { z } from "zod";
import { withPublic } from "@/lib/http/public-api";
import { okResponse, readJson } from "@/lib/http/api";
import { createChallenge } from "@/lib/services/activations";

const schema = z.object({
  product_id: z.string().uuid().optional(),
  device: z.object({
    device_instance_id: z.string().trim().min(4).max(120),
    platform: z.string().trim().min(2).max(40),
    device_name: z.string().trim().max(160).nullish(),
    public_key: z.string().min(32),
  }),
});

/** POST /api/v1/activation-challenges（规格 4.6）：签名挑战，nonce 一次性消费。 */
export async function POST(req: NextRequest) {
  return withPublic(req, async ({ client, requestId }) => {
    const body = await readJson(req, schema);
    if (body.product_id && body.product_id !== client.productId) {
      const { ApiError } = await import("@/lib/http/api");
      throw new ApiError(422, "PRODUCT_MISMATCH", "product_id 与客户端标识不匹配");
    }
    const challenge = await createChallenge(client, {
      deviceInstanceId: body.device.device_instance_id,
      platform: body.device.platform,
      deviceName: body.device.device_name ?? null,
      publicKey: body.device.public_key,
    });
    return okResponse(challenge, requestId);
  });
}
