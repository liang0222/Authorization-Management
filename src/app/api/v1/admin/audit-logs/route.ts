import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, pageResult, readListQuery } from "@/lib/http/api";

/**
 * 操作审计（规格 2.3-G / 9）。
 *
 * - audit_logs 只追加不修改；本接口是只读视图，不能有写操作。
 * - actor 名字需要 join users；audit_logs.actor_id 可能为空（system/client 事件），用 LEFT JOIN。
 * - 过滤与分页全部走 $n 参数占位符；排序固定 created_at DESC（审计按时间倒序阅读）。
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface FilterSet {
  clause: string;
  args: unknown[];
}

function parseDateParam(value: string | null, field: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} 必须是合法的 ISO 时间`);
  }
  return date;
}

function buildFilters(organizationId: string, search: URLSearchParams): FilterSet {
  const args: unknown[] = [organizationId];
  const conditions: string[] = ["a.organization_id = $1::uuid"];

  const action = (search.get("action") ?? "").trim();
  if (action) {
    args.push(`%${action}%`);
    conditions.push(`a.action ILIKE $${args.length}`);
  }

  // resourceType 是固定枚举式的短标识（license / product / credential ...），用精确匹配避免误命中。
  const resourceType = (search.get("resourceType") ?? "").trim();
  if (resourceType) {
    args.push(resourceType);
    conditions.push(`a.resource_type = $${args.length}`);
  }

  const actorId = (search.get("actorId") ?? "").trim();
  if (actorId) {
    if (!UUID_RE.test(actorId)) {
      throw new ApiError(400, "INVALID_REQUEST", "actorId 必须是合法的 UUID");
    }
    args.push(actorId);
    conditions.push(`a.actor_id = $${args.length}::uuid`);
  }

  const from = parseDateParam(search.get("from"), "from");
  if (from) {
    args.push(from);
    conditions.push(`a.created_at >= $${args.length}`);
  }
  const to = parseDateParam(search.get("to"), "to");
  if (to) {
    args.push(to);
    conditions.push(`a.created_at <= $${args.length}`);
  }

  // 通用搜索框：动作、资源类型、request_id 任一命中。
  const q = (search.get("q") ?? "").trim();
  if (q) {
    args.push(`%${q}%`);
    const index = args.length;
    conditions.push(
      `(a.action ILIKE $${index} OR a.resource_type ILIKE $${index} OR a.request_id ILIKE $${index})`,
    );
  }

  return { clause: conditions.join(" AND "), args };
}

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_data: unknown;
  after_data: unknown;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

/** 前后快照的顶层字段差异，作为列表里的“摘要”，避免前端自己 diff 一份 JSON。 */
function changedFields(before: unknown, after: unknown): string[] {
  const beforeObject =
    before && typeof before === "object" ? (before as Record<string, unknown>) : {};
  const afterObject = after && typeof after === "object" ? (after as Record<string, unknown>) : {};
  const keys = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(beforeObject[key]) !== JSON.stringify(afterObject[key])) changed.push(key);
  }
  return changed.slice(0, 20);
}

export async function GET(req: NextRequest) {
  return withAdmin(req, "audit:read", async ({ session, requestId }) => {
    const url = new URL(req.url);
    const query = readListQuery(url);
    const { clause, args } = buildFilters(session.organization.id, url.searchParams);

    const limitIndex = args.length + 1;
    const offsetIndex = args.length + 2;

    const [rows, countRows] = await Promise.all([
      prisma.$queryRawUnsafe<AuditRow[]>(
        `SELECT a.id::text AS id, a.actor_type, a.actor_id,
                u.display_name AS actor_name, u.email AS actor_email,
                a.action, a.resource_type, a.resource_id,
                a.before_data, a.after_data, a.request_id,
                host(a.ip) AS ip, a.user_agent, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE ${clause}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        ...args,
        query.pageSize,
        query.skip,
      ),
      prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
        `SELECT count(*)::bigint AS total FROM audit_logs a WHERE ${clause}`,
        ...args,
      ),
    ]);

    const total = Number(countRows[0]?.total ?? 0);
    const items = rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      // 系统/客户端事件没有关联用户，actorName 为空时前端按 actorType 展示。
      actorName: row.actor_name,
      actorEmail: row.actor_email,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      before: row.before_data,
      after: row.after_data,
      changedFields: changedFields(row.before_data, row.after_data),
      requestId: row.request_id,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: row.created_at.toISOString(),
    }));

    return okResponse(pageResult(items, total, query), requestId);
  });
}
