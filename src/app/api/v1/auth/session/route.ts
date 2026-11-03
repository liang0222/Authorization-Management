import type { NextRequest } from "next/server";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse } from "@/lib/http/api";
import { NAV_GROUPS } from "@/lib/domain/permissions";

/** 当前会话：前端据此渲染用户菜单、导航可见性与按钮权限。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId }) => {
    const navGroups = NAV_GROUPS.map((group) => ({
      title: group.title,
      items: group.items.filter((item) => session.permissions.has(item.permission)),
    })).filter((group) => group.items.length > 0);

    return okResponse(
      {
        user: session.user,
        organization: session.organization,
        role: session.role,
        permissions: Array.from(session.permissions).sort(),
        navGroups,
        expiresAt: session.expiresAt.toISOString(),
        csrfCookieName: "lic_csrf",
      },
      requestId,
    );
  });
}
