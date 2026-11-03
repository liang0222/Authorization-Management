import { prisma } from "@/lib/db";

/**
 * 审计日志（规格 2.3-G / 9）。
 * 所有授权状态变更、续费、解绑、导出都必须调用这里；失败不影响主业务（仅记录告警）。
 */

export interface AuditInput {
  organizationId: string;
  actorType: "admin" | "system" | "client";
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const candidate = ip.trim();
  const isV4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(candidate);
  const isV6 = candidate.includes(":") && /^[0-9a-fA-F:.]+$/.test(candidate);
  return isV4 || isV6 ? candidate : null;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.audit_logs.create({
      data: {
        organization_id: input.organizationId,
        actor_type: input.actorType,
        actor_id: input.actorId,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        before_data: (input.before ?? null) as never,
        after_data: (input.after ?? null) as never,
        request_id: input.requestId ?? null,
        ip: normalizeIp(input.ip),
        user_agent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] 写入失败", { action: input.action, error });
  }
}

/** 对外部客户端的授权校验请求写入 api_request_logs（“验证日志”页面数据源）。 */
export async function recordVerification(input: {
  organizationId: string | null;
  productId: string | null;
  requestId: string;
  method: string;
  route: string;
  status: number;
  errorCode?: string | null;
  latencyMs: number;
  ip?: string | null;
}): Promise<void> {
  try {
    await prisma.api_request_logs.create({
      data: {
        organization_id: input.organizationId,
        product_id: input.productId,
        request_id: input.requestId,
        method: input.method,
        route: input.route,
        response_status: input.status,
        error_code: input.errorCode ?? null,
        latency_ms: input.latencyMs,
        ip: normalizeIp(input.ip),
      },
    });
  } catch (error) {
    console.error("[verification-log] 写入失败", error);
  }
}
