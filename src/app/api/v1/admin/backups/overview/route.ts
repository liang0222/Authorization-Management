import type { NextRequest } from "next/server";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse } from "@/lib/http/api";
import { buildBackupOverview } from "@/lib/services/backup/overview";

/** 备份与灾备概览：最近的成功/失败/校验/演练、RPO/RTO、目标健康、30 天成功率。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "backup:read", async ({ session, requestId }) => {
    const overview = await buildBackupOverview(session.organization.id);
    return okResponse(overview, requestId);
  });
}
