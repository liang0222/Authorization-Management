import type { NextRequest } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse, readJson } from "@/lib/http/api";
import { updateLicenseFeatureOverrides } from "@/lib/services/licenses";

/**
 * PUT /api/v1/admin/licenses/{id}/features（P1-3）：全量设置授权级功能覆盖。
 *
 * 用 PUT 而不是 PATCH，是因为语义就是「覆盖集合整体替换」：
 * 传 `{"overrides": []}` 等于清空所有覆盖、回落到套餐/产品默认值。
 * 这样前端不需要维护「这次删了哪一条」的差异，也不会出现
 * 「删掉的覆盖其实还在库里」的幽灵权限。
 *
 * 权限沿用 `license:issue`：能签发授权的人才能调它的权限位，
 * 单独再开一个 `license:features` 只会让角色配置更碎。
 */
const schema = z.object({
  overrides: z
    .array(
      z.object({
        code: z.string().trim().min(1, "功能编码不能为空").max(100),
        value: z.unknown(),
      }),
    )
    .max(200, "一次最多设置 200 个功能覆盖"),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(req, "license:issue", async ({ session, requestId, ip, userAgent }) => {
    const { id } = await ctx.params;
    const body = await readJson(req, schema);
    const result = await updateLicenseFeatureOverrides(
      {
        organizationId: session.organization.id,
        actorId: session.user.id,
        requestId,
        ip,
        userAgent,
      },
      id,
      body.overrides,
    );
    return okResponse(
      {
        updated: true,
        /** 客户端下次心跳会看到这个新版本号，据此决定要不要重新拉权限。 */
        entitlements_version: result.entitlementsVersion,
        /** 合并后的完整快照（产品默认 + 套餐 + 覆盖），与 `/entitlements` 返回的一致。 */
        entitlements: result.snapshot,
        overrides: result.overrides,
      },
      requestId,
    );
  });
}