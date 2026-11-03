import { NextResponse, type NextRequest } from "next/server";
import { withAdmin } from "@/lib/auth/guard";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  revokeSession,
} from "@/lib/auth/session";
import { successBody } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

export async function POST(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId, ip, userAgent }) => {
    await revokeSession(session.sessionId);
    await writeAudit({
      organizationId: session.organization.id,
      actorType: "admin",
      actorId: session.user.id,
      action: "auth.logout",
      resourceType: "session",
      resourceId: session.sessionId,
      requestId,
      ip,
      userAgent,
    });
    const response = NextResponse.json(successBody({ loggedOut: true }, requestId));
    response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    response.cookies.set(CSRF_COOKIE, "", { path: "/", maxAge: 0 });
    response.headers.set("x-request-id", requestId);
    return response;
  });
}
