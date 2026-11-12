import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse } from "@/lib/http/api";
import { SECURITY_ALERT_ACTIONS } from "@/lib/services/security-alerts";

/**
 * 最近安全告警（阶段 6）。
 *
 * 只读视图：数据源就是 `audit_logs` 里 `auth.login_bruteforce` /
 * `authz.probing` 两类 action。没有配置外发 webhook 的部署也能在系统设置页
 * 直接看到最近发生了什么，不必去翻 journalctl。
 *
 * 权限用 `audit:read` 而不是 `settings:read`：告警本身是审计数据，
 * 能看审计日志的角色就应该能看它；系统设置页只是入口，不是权限来源。
 */
export async function GET(req: NextRequest) {
  return withAdmin(req, "audit:read", async ({ session, requestId }) => {
    const [rows, total] = await Promise.all([
      prisma.audit_logs.findMany({
        where: {
          organization_id: session.organization.id,
          action: { in: [...SECURITY_ALERT_ACTIONS] },
        },
        orderBy: { created_at: "desc" },
        take: 20,
      }),
      prisma.audit_logs.count({
        where: {
          organization_id: session.organization.id,
          action: { in: [...SECURITY_ALERT_ACTIONS] },
        },
      }),
    ]);

    return okResponse(
      {
        alerts: rows.map((row) => ({
          id: row.id.toString(),
          action: row.action,
          severity: "warning" as const,
          actorType: row.actor_type,
          actorId: row.actor_id,
          ip: row.ip,
          requestId: row.request_id,
          // 这里刻意不再二次挑选字段：after_data 是告警写入时构造的白名单结构，
          // 不含密码/token；前端按维度渲染即可。
          dimensions: row.after_data,
          createdAt: row.created_at.toISOString(),
        })),
        total,
        limit: 20,
      },
      requestId,
    );
  });
}
