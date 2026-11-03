import type { NextRequest } from "next/server";
import { z } from "zod";
import { withPublic } from "@/lib/http/public-api";
import { okResponse, readJson } from "@/lib/http/api";
import { validateLicenseKey } from "@/lib/services/activations";

const schema = z.object({ license_key: z.string().trim().min(1).max(80) });

/**
 * POST /api/v1/licenses/validate（规格 4.11）：非绑定预检查。
 * 未认证调用不暴露“授权码是否存在”的差异，统一返回 valid=false + LICENSE_INVALID。
 */
export async function POST(req: NextRequest) {
  return withPublic(req, async ({ client, requestId }) => {
    const body = await readJson(req, schema);
    const result = await validateLicenseKey(client, body.license_key);
    return okResponse(result, requestId);
  });
}
