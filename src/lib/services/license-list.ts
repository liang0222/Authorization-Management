import { prisma } from "@/lib/db";
import { maskLicenseKey } from "@/lib/domain/license-key";
import {
  computeEffectiveState,
  type LicenseAdminStatus,
} from "@/lib/domain/effective-status";
import type { DurationUnit } from "@/lib/domain/period";
import { mapLicenseRow, type LicenseListRow } from "@/lib/services/licenses";
import type { PageResult } from "@/lib/http/api";

/**
 * 授权列表：服务端分页/排序/筛选。
 *
 * 由于“有效状态”是计算值（规格 3.2），无法用普通 Prisma where 精确表达，
 * 这里用参数化 SQL 把同一套判定逻辑写成 CASE 表达式，保证分页与筛选一致。
 * 展示文案仍由 TypeScript 的 computeEffectiveState 计算，两边条件必须同步修改。
 */

const EFFECTIVE_STATUS_EXPR = `
  CASE
    WHEN p.status <> 'active' THEN 'product_disabled'
    WHEN l.admin_status = 'revoked' THEN 'revoked'
    WHEN l.admin_status = 'cancelled' THEN 'cancelled'
    WHEN l.admin_status = 'suspended' THEN 'suspended'
    WHEN l.admin_status = 'draft' THEN 'draft'
    WHEN ((l.activation_count = 0 AND l.starts_at IS NULL)
          AND l.activation_deadline_at IS NOT NULL
          AND l.activation_deadline_at < now()) THEN 'activation_window_expired'
    WHEN l.starts_at IS NOT NULL AND l.starts_at > now() THEN 'not_yet_valid'
    WHEN l.expires_at IS NOT NULL AND l.expires_at <= now() THEN 'expired'
    ELSE 'active'
  END
`;

const SORT_COLUMNS: Record<string, string> = {
  created_at: "l.created_at",
  expires_at: "l.expires_at",
  starts_at: "l.starts_at",
  activation_count: "l.activation_count",
  max_devices: "l.max_devices",
  customer: "c.name",
  product: "p.name",
};

const ADMIN_STATUSES: LicenseAdminStatus[] = [
  "draft",
  "pending",
  "active",
  "suspended",
  "revoked",
  "cancelled",
];

const EFFECTIVE_STATUSES = [
  "active",
  "expired",
  "suspended",
  "revoked",
  "cancelled",
  "draft",
  "not_yet_valid",
  "activation_window_expired",
  "product_disabled",
] as const;

export interface LicenseQueryParams {
  page: number;
  pageSize: number;
  /** 直接给定偏移（游标分页用）；不给时按 page/pageSize 换算。 */
  offset?: number;
  q: string;
  sort: string | null;
  order: "asc" | "desc";
  productId?: string;
  customerId?: string;
  adminStatus?: string[];
  effectiveStatus?: string;
  expiringInDays?: number;
  createdFrom?: string;
  createdTo?: string;
}

interface LicenseSqlRow {
  id: string;
  admin_status: LicenseAdminStatus;
  duration_unit: DurationUnit;
  duration_value: number;
  starts_at: Date | null;
  expires_at: Date | null;
  activation_deadline_at: Date | null;
  max_devices: number;
  max_activation_count: number | null;
  activation_count: number;
  created_at: Date;
  timezone: string;
  effective_status: string;
  active_devices: number;
  product_id: string;
  product_name: string;
  product_code: string;
  product_type: string;
  product_status: "active" | "disabled" | "archived";
  customer_id: string;
  customer_name: string;
  customer_email: string | null;
  key_last4: string | null;
}

function buildWhere(orgId: string, params: LicenseQueryParams): { clause: string; args: unknown[] } {
  const args: unknown[] = [orgId];
  const conditions: string[] = ["l.organization_id = $1::uuid", "l.deleted_at IS NULL"];

  if (params.productId) {
    args.push(params.productId);
    conditions.push(`l.product_id = $${args.length}::uuid`);
  }
  if (params.customerId) {
    args.push(params.customerId);
    conditions.push(`l.customer_id = $${args.length}::uuid`);
  }
  if (params.adminStatus && params.adminStatus.length > 0) {
    const statuses = params.adminStatus.filter((s) => ADMIN_STATUSES.includes(s as LicenseAdminStatus));
    if (statuses.length > 0) {
      args.push(statuses);
      conditions.push(`l.admin_status = ANY($${args.length}::license_admin_status[])`);
    }
  }
  if (params.expiringInDays && params.expiringInDays > 0) {
    args.push(params.expiringInDays);
    conditions.push(
      `l.expires_at IS NOT NULL AND l.expires_at > now() AND l.expires_at <= now() + ($${args.length} || ' days')::interval`,
    );
  }
  if (params.createdFrom) {
    args.push(params.createdFrom);
    conditions.push(`l.created_at >= $${args.length}::timestamptz`);
  }
  if (params.createdTo) {
    args.push(params.createdTo);
    conditions.push(`l.created_at <= $${args.length}::timestamptz`);
  }
  if (params.q) {
    args.push(`%${params.q}%`);
    const idx = args.length;
    const exactKey = params.q.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
    args.push(exactKey || "___none___");
    conditions.push(`(
      c.name ILIKE $${idx} OR c.email ILIKE $${idx} OR p.name ILIKE $${idx}
      OR l.external_order_id ILIKE $${idx} OR l.id::text ILIKE $${idx}
      OR EXISTS (SELECT 1 FROM license_keys lk WHERE lk.license_id = l.id
                 AND (lk.key_last4 = right($${idx + 1}, 4) OR lk.key_prefix ILIKE $${idx}))
    )`);
  }
  if (params.effectiveStatus && (EFFECTIVE_STATUSES as readonly string[]).includes(params.effectiveStatus)) {
    args.push(params.effectiveStatus);
    conditions.push(`(${EFFECTIVE_STATUS_EXPR}) = $${args.length}`);
  }

  return { clause: conditions.join(" AND "), args };
}

export async function queryLicenses(
  organizationId: string,
  params: LicenseQueryParams,
): Promise<Omit<PageResult<LicenseListRow>, "next_cursor" | "has_more" | "pagination">> {
  const { clause, args } = buildWhere(organizationId, params);
  const sortColumn = SORT_COLUMNS[params.sort ?? "created_at"] ?? SORT_COLUMNS.created_at;
  const order = params.order === "asc" ? "ASC" : "DESC";
  const limitArg = args.length + 1;
  const offsetArg = args.length + 2;

  const rows = await prisma.$queryRawUnsafe<LicenseSqlRow[]>(
    `
    SELECT l.id, l.admin_status, l.duration_unit, l.duration_value, l.starts_at, l.expires_at,
           l.activation_deadline_at, l.max_devices, l.max_activation_count, l.activation_count,
           l.created_at, l.timezone,
           (${EFFECTIVE_STATUS_EXPR}) AS effective_status,
           p.id AS product_id, p.name AS product_name, p.code AS product_code,
           p.product_type::text AS product_type, p.status AS product_status,
           c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
           (SELECT count(*)::int FROM activations a WHERE a.license_id = l.id AND a.status = 'active') AS active_devices,
           (SELECT lk.key_last4 FROM license_keys lk WHERE lk.license_id = l.id AND lk.status = 'active' ORDER BY lk.created_at DESC LIMIT 1) AS key_last4
    FROM licenses l
    JOIN products p ON p.id = l.product_id
    JOIN customers c ON c.id = l.customer_id
    WHERE ${clause}
    ORDER BY ${sortColumn} ${order} NULLS LAST, l.id
    LIMIT $${limitArg} OFFSET $${offsetArg}
    `,
    ...args,
    params.pageSize,
    params.offset ?? (params.page - 1) * params.pageSize,
  );

  const countRows = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
    `
    SELECT count(*)::bigint AS total
    FROM licenses l
    JOIN products p ON p.id = l.product_id
    JOIN customers c ON c.id = l.customer_id
    WHERE ${clause}
    `,
    ...args,
  );
  const total = Number(countRows[0]?.total ?? 0);
  const now = new Date();

  const items = rows.map((row) =>
    mapLicenseRow(
      {
        id: row.id,
        admin_status: row.admin_status,
        duration_unit: row.duration_unit,
        duration_value: row.duration_value,
        starts_at: row.starts_at,
        expires_at: row.expires_at,
        activation_deadline_at: row.activation_deadline_at,
        max_devices: row.max_devices,
        max_activation_count: row.max_activation_count,
        activation_count: row.activation_count,
        created_at: row.created_at,
        timezone: row.timezone,
        products: {
          id: row.product_id,
          name: row.product_name,
          code: row.product_code,
          product_type: row.product_type,
          status: row.product_status,
        },
        customers: { id: row.customer_id, name: row.customer_name, email: row.customer_email },
        license_keys: row.key_last4 ? [{ key_last4: row.key_last4, status: "active" }] : [],
      },
      Number(row.active_devices ?? 0),
      maskLicenseKey,
      now,
    ),
  );

  return {
    items,
    page: params.page,
    pageSize: params.pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

/** 授权详情：概览 + 设备 + 功能 + 续费 + 事件。 */
export async function getLicenseDetail(organizationId: string, licenseId: string) {
  const license = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: organizationId, deleted_at: null },
    include: {
      products: true,
      customers: true,
      plans: true,
      license_keys: { orderBy: { created_at: "desc" } },
      license_features: { orderBy: { feature_code: "asc" } },
      license_renewals: { orderBy: { created_at: "desc" } },
      activations: {
        orderBy: { activated_at: "desc" },
        include: { devices: true },
      },
      users: { select: { id: true, display_name: true, email: true } },
    },
  });
  if (!license) return null;

  const activeDevices = license.activations.filter((a) => a.status === "active").length;
  const effective = computeEffectiveState(
    {
      adminStatus: license.admin_status,
      productStatus: license.products.status,
      startsAt: license.starts_at,
      expiresAt: license.expires_at,
      activationDeadlineAt: license.activation_deadline_at,
      hasActivated: license.activation_count > 0 || license.starts_at !== null,
      activeDeviceCount: activeDevices,
      maxDevices: license.max_devices,
      activationCount: license.activation_count,
      maxActivationCount: license.max_activation_count,
    },
    new Date(),
  );

  const events = await prisma.activation_events.findMany({
    where: { organization_id: organizationId, activation_id: { in: license.activations.map((a) => a.id) } },
    orderBy: { created_at: "desc" },
    take: 50,
  });

  const auditLogs = await prisma.audit_logs.findMany({
    where: { organization_id: organizationId, resource_type: "license", resource_id: licenseId },
    orderBy: { created_at: "desc" },
    take: 50,
  });

  return {
    license,
    effective,
    activeDevices,
    events,
    auditLogs,
  };
}
