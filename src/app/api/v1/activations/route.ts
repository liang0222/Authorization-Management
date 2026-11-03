import type { NextRequest } from "next/server";
import { z } from "zod";
import { withPublic, withIdempotency } from "@/lib/http/public-api";
import { ApiError, okResponse } from "@/lib/http/api";
import { activate } from "@/lib/services/activations";

/**
 * 兼容两代请求体（规格 4.7 + v1.4 客户端）：
 * - v1.5：`signature` 放在 `device.signature`，客户端信息是 `client:{app_version, sdk_version}`。
 * - v1.4：`signature` 在顶层，客户端信息是 `client_version` 字符串。
 * 两者都接受，避免已发布的 EXE 因为升级服务端而失联。
 */
const schema = z.object({
  product_id: z.string().uuid().nullish(),
  license_key: z.string().trim().min(20).max(80),
  challenge_id: z.string().uuid(),
  device: z.object({
    device_instance_id: z.string().trim().min(4).max(120),
    platform: z.string().trim().min(2).max(40),
    device_name: z.string().trim().max(160).nullish(),
    public_key: z.string().min(32),
    signature: z.string().min(20).nullish(),
  }),
  signature: z.string().min(20).nullish(),
  canonical_version: z.enum(["v1", "legacy"]).nullish(),
  client_version: z.string().max(80).nullish(),
  client: z
    .object({
      app_version: z.string().max(80).nullish(),
      sdk_version: z.string().max(80).nullish(),
    })
    .nullish(),
});

/**
 * POST /api/v1/activations（规格 4.7）。
 * - 必须带 Idempotency-Key；同 key 同体返回首次结果，不同体 409。
 * - 事务内锁 License 行，验证并发下不会突破 max_devices。
 * - 同时签发 access_token 与 refresh_token（refresh 只返回这一次，库里只存哈希）。
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  return withPublic(req, async ({ client, requestId, ip }) => {
    return withIdempotency(req, client, "activations", rawBody, async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON");
      }
      const body = schema.parse(parsed);

      if (body.product_id && body.product_id !== client.productId) {
        throw new ApiError(422, "PRODUCT_MISMATCH", "product_id 与客户端标识不匹配");
      }
      const signature = body.device.signature ?? body.signature;
      if (!signature) {
        throw new ApiError(400, "INVALID_REQUEST", "缺少设备签名（device.signature 或 signature）");
      }

      const result = await activate(client, {
        licenseKey: body.license_key,
        challengeId: body.challenge_id,
        deviceInstanceId: body.device.device_instance_id,
        platform: body.device.platform,
        deviceName: body.device.device_name ?? null,
        publicKey: body.device.public_key,
        signature,
        canonicalVersion: body.canonical_version ?? null,
        clientVersion:
          body.client?.app_version ?? body.client_version ?? body.client?.sdk_version ?? null,
        ip,
      });

      return okResponse(result, requestId, { status: 201 });
    });
  });
}
