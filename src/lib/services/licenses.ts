import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { ApiError } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";
import { enqueueWebhook } from "@/lib/services/webhook-events";
import {
  addDuration,
  renewalStart,
  type DurationInput,
  type DurationUnit,
} from "@/lib/domain/period";
import {
  computeEffectiveState,
  type EffectiveState,
  type LicenseAdminStatus,
} from "@/lib/domain/effective-status";
import {
  generateLicenseKey,
  hashLicenseKey,
  licenseKeyLast4,
  licenseKeyPrefix,
} from "@/lib/domain/license-key";

export interface ActorContext {
  organizationId: string;
  actorId: string | null;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface IssueLicenseInput {
  productId: string;
  customerId: string;
  planId?: string | null;
  duration: DurationInput;
  startPolicy: "on_first_activation" | "fixed_start";
  startsAt?: Date | null;
  activationDeadlineAt?: Date | null;
  maxDevices: number;
  maxActivationCount?: number | null;
  maxSubjects?: number | null;
  refundActivationOnRelease?: boolean;
  offlineAllowed?: boolean;
  offlineGraceSeconds?: number;
  features?: Record<string, unknown>;
  notes?: string | null;
  externalOrderId?: string | null;
  /** 立即签发（pending）还是保存草稿（draft） */
  publish?: boolean;
}

export interface IssuedLicense {
  id: string;
  licenseKey: string;
  adminStatus: LicenseAdminStatus;
  durationLabel: string;
  startsAt: Date | null;
  expiresAt: Date | null;
}

const DURATION_LABEL: Record<string, string> = {
  day: "天",
  month: "个自然月",
  lifetime: "永久",
};

function durationText(unit: DurationUnit, value: number): string {
  if (unit === "lifetime") return "永久";
  return `${value} ${DURATION_LABEL[unit] ?? unit}`;
}

/** 产品默认值 → 套餐权限 → 授权覆盖值（规格 2.4 第 6 条）。 */
export async function computeFeatureSnapshot(
  organizationId: string,
  productId: string,
  planId: string | null | undefined,
  overrides: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const [productFeatures, planFeatures, plan] = await Promise.all([
    prisma.product_features.findMany({
      where: { product_id: productId, organization_id: organizationId, status: "active" },
      select: { code: true, default_value: true },
    }),
    planId
      ? prisma.plan_features.findMany({
          where: { plan_id: planId, organization_id: organizationId },
          select: { feature_code: true, feature_value: true },
        })
      : Promise.resolve([]),
    planId ? prisma.plans.findFirst({ where: { id: planId, organization_id: organizationId } }) : Promise.resolve(null),
  ]);

  const snapshot: Record<string, unknown> = {};
  for (const feature of productFeatures) {
    snapshot[feature.code] = feature.default_value;
  }
  if (plan?.default_features && typeof plan.default_features === "object") {
    Object.assign(snapshot, plan.default_features as Record<string, unknown>);
  }
  for (const row of planFeatures) {
    snapshot[row.feature_code] = row.feature_value;
  }
  Object.assign(snapshot, overrides ?? {});
  return snapshot;
}

export async function issueLicense(
  actor: ActorContext,
  input: IssueLicenseInput,
): Promise<IssuedLicense> {
  const org = await prisma.organizations.findUnique({ where: { id: actor.organizationId } });
  if (!org) throw new ApiError(404, "RESOURCE_NOT_FOUND", "组织不存在");

  const [product, customer, plan] = await Promise.all([
    prisma.products.findFirst({ where: { id: input.productId, organization_id: actor.organizationId } }),
    prisma.customers.findFirst({ where: { id: input.customerId, organization_id: actor.organizationId } }),
    input.planId
      ? prisma.plans.findFirst({ where: { id: input.planId, organization_id: actor.organizationId } })
      : Promise.resolve(null),
  ]);
  if (!product) throw new ApiError(404, "RESOURCE_NOT_FOUND", "产品不存在或不属于当前组织");
  if (product.status !== "active") throw new ApiError(409, "CONFLICT", "产品已禁用，无法签发授权");
  if (!customer) throw new ApiError(404, "RESOURCE_NOT_FOUND", "客户不存在或不属于当前组织");
  if (input.planId && !plan) throw new ApiError(404, "RESOURCE_NOT_FOUND", "套餐不存在或不属于当前产品");
  if (plan && plan.product_id !== input.productId) {
    throw new ApiError(422, "PRODUCT_MISMATCH", "套餐不属于该产品");
  }

  if (input.duration.unit === "lifetime" && input.duration.value !== 0) {
    throw new ApiError(400, "INVALID_REQUEST", "永久授权的 duration_value 必须为 0");
  }
  if (input.duration.unit !== "lifetime" && input.duration.value <= 0) {
    throw new ApiError(400, "INVALID_REQUEST", "周期天数/月数必须大于 0");
  }

  const timezone = org.timezone;
  const now = new Date();
  let startsAt: Date | null = null;
  let expiresAt: Date | null = null;
  if (input.startPolicy === "fixed_start") {
    if (!input.startsAt) throw new ApiError(400, "INVALID_REQUEST", "固定起算方式必须提供 starts_at");
    startsAt = input.startsAt;
    expiresAt = addDuration(startsAt, input.duration, timezone);
    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      throw new ApiError(400, "INVALID_REQUEST", "固定起算的开始时间加周期后已经过期，请调整");
    }
  }

  const featureSnapshot = await computeFeatureSnapshot(
    actor.organizationId,
    input.productId,
    input.planId,
    input.features,
  );

  const plaintextKey = generateLicenseKey();
  const publish = input.publish !== false;

  const created = await prisma.$transaction(async (tx) => {
    const license = await tx.licenses.create({
      data: {
        organization_id: actor.organizationId,
        product_id: input.productId,
        customer_id: input.customerId,
        plan_id: input.planId ?? null,
        external_order_id: input.externalOrderId ?? null,
        admin_status: publish ? "pending" : "draft",
        duration_unit: input.duration.unit,
        duration_value: input.duration.value,
        start_policy: input.startPolicy,
        timezone,
        starts_at: startsAt,
        expires_at: expiresAt,
        activation_deadline_at: input.activationDeadlineAt ?? null,
        max_devices: input.maxDevices,
        max_activation_count: input.maxActivationCount ?? null,
        max_subjects: input.maxSubjects ?? null,
        refund_activation_on_release: input.refundActivationOnRelease ?? false,
        offline_allowed: input.offlineAllowed ?? false,
        offline_grace_seconds: input.offlineGraceSeconds ?? 0,
        feature_snapshot: featureSnapshot as never,
        notes: input.notes ?? null,
        metadata: { issued_at_server_time: now.toISOString() },
        created_by: actor.actorId,
      },
    });

    if (publish) {
      await tx.license_keys.create({
        data: {
          organization_id: actor.organizationId,
          license_id: license.id,
          key_prefix: licenseKeyPrefix(plaintextKey),
          key_last4: licenseKeyLast4(plaintextKey),
          key_hash: hashLicenseKey(plaintextKey),
          hash_key_version: config.licenseHmacPepperVersion,
        },
      });
    }

    // 授权级覆盖值单独存一份，便于后续差异对比（快照始终保存合并结果）
    if (input.features && Object.keys(input.features).length > 0) {
      const rows = Object.entries(input.features).map(([code, value]) => ({
        license_id: license.id,
        product_id: input.productId,
        organization_id: actor.organizationId,
        feature_code: code,
        feature_value: value as never,
      }));
      await tx.license_features.createMany({ data: rows, skipDuplicates: true });
    }

    return license;
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: publish ? "license.issue" : "license.draft",
    resourceType: "license",
    resourceId: created.id,
    after: {
      product_id: input.productId,
      customer_id: input.customerId,
      duration: input.duration,
      max_devices: input.maxDevices,
      max_activation_count: input.maxActivationCount ?? null,
    },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });

  return {
    id: created.id,
    licenseKey: plaintextKey,
    adminStatus: created.admin_status,
    durationLabel: durationText(input.duration.unit, input.duration.value),
    startsAt: created.starts_at,
    expiresAt: created.expires_at,
  };
}

interface LockableLicense {
  id: string;
  organization_id: string;
  product_id: string;
  admin_status: LicenseAdminStatus;
  duration_unit: DurationUnit;
  duration_value: number;
  timezone: string;
  starts_at: Date | null;
  expires_at: Date | null;
  activation_count: number;
  max_devices: number;
  max_activation_count: number | null;
}

/** 读取并锁定 License 行，供状态变更使用。 */
async function lockLicense(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  organizationId: string,
  licenseId: string,
): Promise<LockableLicense> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM licenses WHERE id = ${licenseId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE
  `;
  if (rows.length === 0) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  const license = await tx.licenses.findFirst({
    where: { id: licenseId, organization_id: organizationId },
    select: {
      id: true,
      organization_id: true,
      product_id: true,
      admin_status: true,
      duration_unit: true,
      duration_value: true,
      timezone: true,
      starts_at: true,
      expires_at: true,
      activation_count: true,
      max_devices: true,
      max_activation_count: true,
    },
  });
  if (!license) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  return license;
}

export async function suspendLicense(actor: ActorContext, licenseId: string, reason: string | null) {
  const before = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: actor.organizationId },
  });
  if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  if (!["pending", "active"].includes(before.admin_status)) {
    throw new ApiError(409, "CONFLICT", `当前状态（${before.admin_status}）不可暂停`);
  }
  const updated = await prisma.licenses.update({
    where: { id: licenseId },
    data: {
      admin_status: "suspended",
      metadata: {
        ...((before.metadata ?? {}) as Record<string, unknown>),
        suspended_reason: reason,
        suspended_at: new Date().toISOString(),
        suspended_by: actor.actorId,
      },
    },
  });
  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.suspend",
    resourceType: "license",
    resourceId: licenseId,
    before: { admin_status: before.admin_status },
    after: { admin_status: "suspended", reason },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await enqueueWebhook(actor.organizationId, "license.suspended", {
    license_id: licenseId,
    product_id: before.product_id,
    customer_id: before.customer_id,
    reason,
    occurred_at: new Date().toISOString(),
  });
  return updated;
}

export async function resumeLicense(actor: ActorContext, licenseId: string) {
  const before = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: actor.organizationId },
  });
  if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  if (before.admin_status !== "suspended") {
    throw new ApiError(409, "CONFLICT", "只有已暂停的授权可以恢复");
  }
  const nextStatus: LicenseAdminStatus = before.activation_count > 0 ? "active" : "pending";
  const updated = await prisma.licenses.update({
    where: { id: licenseId },
    data: { admin_status: nextStatus },
  });
  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.resume",
    resourceType: "license",
    resourceId: licenseId,
    before: { admin_status: "suspended" },
    after: { admin_status: nextStatus },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await enqueueWebhook(actor.organizationId, "license.resumed", {
    license_id: licenseId,
    product_id: before.product_id,
    customer_id: before.customer_id,
    effective_status: nextStatus,
    occurred_at: new Date().toISOString(),
  });
  return updated;
}

export async function revokeLicense(actor: ActorContext, licenseId: string, reason: string) {
  const before = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: actor.organizationId },
  });
  if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  if (before.admin_status === "revoked" || before.admin_status === "cancelled") {
    throw new ApiError(409, "CONFLICT", "授权已处于终态，不能再次撤销");
  }
  const updated = await prisma.licenses.update({
    where: { id: licenseId },
    data: {
      admin_status: "revoked",
      metadata: {
        ...((before.metadata ?? {}) as Record<string, unknown>),
        revoked_reason: reason,
        revoked_at: new Date().toISOString(),
      },
    },
  });
  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.revoke",
    resourceType: "license",
    resourceId: licenseId,
    before: { admin_status: before.admin_status },
    after: { admin_status: "revoked", reason },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await enqueueWebhook(actor.organizationId, "license.revoked", {
    license_id: licenseId,
    product_id: before.product_id,
    customer_id: before.customer_id,
    reason,
    occurred_at: new Date().toISOString(),
  });
  return updated;
}

export async function cancelLicense(actor: ActorContext, licenseId: string, reason: string | null) {
  const before = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: actor.organizationId },
  });
  if (!before) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  if (before.admin_status === "revoked" || before.admin_status === "cancelled") {
    throw new ApiError(409, "CONFLICT", "授权已处于终态");
  }
  const updated = await prisma.licenses.update({
    where: { id: licenseId },
    data: {
      admin_status: "cancelled",
      metadata: {
        ...((before.metadata ?? {}) as Record<string, unknown>),
        cancelled_reason: reason,
        cancelled_at: new Date().toISOString(),
      },
    },
  });
  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.cancel",
    resourceType: "license",
    resourceId: licenseId,
    before: { admin_status: before.admin_status },
    after: { admin_status: "cancelled", reason },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  // 规格第 8 节没有 license.cancelled：作废对调用方的可见后果是「权限不再有效」，
  // 因此发 entitlements.updated，让客户端重新拉一次权限而不是继续用缓存。
  await enqueueWebhook(actor.organizationId, "entitlements.updated", {
    license_id: licenseId,
    product_id: before.product_id,
    customer_id: before.customer_id,
    reason: "license_cancelled",
    occurred_at: new Date().toISOString(),
  });
  return updated;
}

export interface RenewResult {
  previousExpiresAt: Date | null;
  newExpiresAt: Date | null;
  renewalStartsAt: Date;
  mode: "append" | "from_now";
}

export async function renewLicense(
  actor: ActorContext,
  licenseId: string,
  duration: DurationInput,
  options: { fromNow?: boolean; paymentRef?: string | null; notes?: string | null } = {},
): Promise<RenewResult> {
  if (duration.unit === "lifetime") {
    throw new ApiError(400, "INVALID_REQUEST", "永久授权不接受普通期限续费，请走套餐变更流程");
  }
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const license = await lockLicense(tx, actor.organizationId, licenseId);
    if (license.admin_status === "revoked" || license.admin_status === "cancelled") {
      throw new ApiError(409, "CONFLICT", "已撤销或作废的授权不能续费");
    }
    if (license.expires_at === null && license.duration_unit === "lifetime") {
      throw new ApiError(400, "INVALID_REQUEST", "永久授权不能按周期续费");
    }
    if (!license.starts_at) {
      throw new ApiError(409, "CONFLICT", "授权尚未首次激活，无法确定起算点，请先激活或使用固定起算方式");
    }
    const previousExpiresAt = license.expires_at;
    const expiredAlready =
      previousExpiresAt === null || previousExpiresAt.getTime() <= now.getTime();
    const start = options.fromNow || expiredAlready ? now : renewalStart(previousExpiresAt, now);
    const newExpiresAt = addDuration(start, duration, license.timezone);
    await tx.licenses.update({
      where: { id: license.id },
      data: {
        expires_at: newExpiresAt,
        admin_status: license.admin_status === "pending" ? "pending" : license.admin_status,
      },
    });
    await tx.license_renewals.create({
      data: {
        organization_id: actor.organizationId,
        license_id: license.id,
        duration_unit: duration.unit,
        duration_value: duration.value,
        previous_expires_at: previousExpiresAt,
        renewal_starts_at: start,
        new_expires_at: newExpiresAt,
        renewal_mode: options.fromNow ? "from_now" : expiredAlready ? "from_now" : "append",
        external_payment_ref: options.paymentRef ?? null,
        notes: options.notes ?? null,
        created_by: actor.actorId,
      },
    });
    return {
      previousExpiresAt,
      newExpiresAt,
      renewalStartsAt: start,
      mode: (options.fromNow || expiredAlready ? "from_now" : "append") as "append" | "from_now",
    };
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.renew",
    resourceType: "license",
    resourceId: licenseId,
    before: { expires_at: result.previousExpiresAt },
    after: { expires_at: result.newExpiresAt, duration, mode: result.mode },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await enqueueWebhook(actor.organizationId, "license.renewed", {
    license_id: licenseId,
    previous_expires_at: result.previousExpiresAt?.toISOString() ?? null,
    new_expires_at: result.newExpiresAt?.toISOString() ?? null,
    renewal_mode: result.mode,
    duration,
    occurred_at: new Date().toISOString(),
  });
  return result;
}

/** 重发兑换码：旧码立即失效，新码明文只在此响应中出现一次。 */
export async function rekeyLicense(actor: ActorContext, licenseId: string) {
  const license = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: actor.organizationId },
  });
  if (!license) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在");
  if (license.admin_status === "revoked" || license.admin_status === "cancelled") {
    throw new ApiError(409, "CONFLICT", "终态授权不能重发兑换码");
  }
  const key = generateLicenseKey();
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${licenseId}::uuid FOR UPDATE`;
    await tx.license_keys.updateMany({
      where: { license_id: licenseId, status: "active" },
      data: { status: "disabled", revoked_at: new Date() },
    });
    await tx.license_keys.create({
      data: {
        organization_id: actor.organizationId,
        license_id: licenseId,
        key_prefix: licenseKeyPrefix(key),
        key_last4: licenseKeyLast4(key),
        key_hash: hashLicenseKey(key),
        hash_key_version: config.licenseHmacPepperVersion,
      },
    });
    await tx.licenses.update({
      where: { id: licenseId },
      data: { admin_status: license.admin_status === "draft" ? "pending" : license.admin_status },
    });
  });
  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.rekey",
    resourceType: "license",
    resourceId: licenseId,
    after: { key_last4: licenseKeyLast4(key) },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { licenseKey: key };
}

/** 受控重置累计激活次数：只允许重置为当前活跃设备数，防止变相放水。 */
export async function resetActivationCount(actor: ActorContext, licenseId: string, reason: string) {
  const activeDevices = await prisma.activations.count({
    where: { license_id: licenseId, organization_id: actor.organizationId, status: "active" },
  });
  const result = await prisma.$transaction(async (tx) => {
    const license = await lockLicense(tx, actor.organizationId, licenseId);
    const updated = await tx.licenses.update({
      where: { id: licenseId },
      data: { activation_count: activeDevices },
    });
    return { before: license.activation_count, after: updated.activation_count };
  });
  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.reset_activation_count",
    resourceType: "license",
    resourceId: licenseId,
    before: { activation_count: result.before },
    after: { activation_count: result.after, reason, active_devices: activeDevices },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return result;
}

export interface LicenseListRow {
  id: string;
  adminStatus: LicenseAdminStatus;
  effective: EffectiveState;
  product: { id: string; name: string; code: string; type: string };
  customer: { id: string; name: string; email: string | null };
  duration: { unit: DurationUnit; value: number };
  startsAt: string | null;
  expiresAt: string | null;
  activationDeadlineAt: string | null;
  maxDevices: number;
  activeDevices: number;
  activationCount: number;
  maxActivationCount: number | null;
  keyMask: string | null;
  createdAt: string;
  timezone: string;
}

interface RawLicenseForList {
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
  products: { id: string; name: string; code: string; product_type: string; status: "active" | "disabled" | "archived" };
  customers: { id: string; name: string; email: string | null };
  license_keys: Array<{ key_last4: string; status: "active" | "disabled" | "archived" }>;
}

export function mapLicenseRow(
  license: RawLicenseForList,
  activeDevices: number,
  encryptionMask: (last4: string) => string,
  now: Date,
): LicenseListRow {
  const activeKey = license.license_keys.find((key) => key.status === "active") ?? null;
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
    now,
  );
  return {
    id: license.id,
    adminStatus: license.admin_status,
    effective,
    product: {
      id: license.products.id,
      name: license.products.name,
      code: license.products.code,
      type: license.products.product_type,
    },
    customer: license.customers,
    duration: { unit: license.duration_unit, value: license.duration_value },
    startsAt: license.starts_at?.toISOString() ?? null,
    expiresAt: license.expires_at?.toISOString() ?? null,
    activationDeadlineAt: license.activation_deadline_at?.toISOString() ?? null,
    maxDevices: license.max_devices,
    activeDevices,
    activationCount: license.activation_count,
    maxActivationCount: license.max_activation_count,
    keyMask: activeKey ? encryptionMask(activeKey.key_last4) : null,
    createdAt: license.created_at.toISOString(),
    timezone: license.timezone,
  };
}

/**
 * 授权级功能覆盖（P1-3）。
 *
 * 为什么需要它：`feature_snapshot` 里存的是签发那一刻的合并结果，
 * 客户加购一个功能、或销售给了个特例，都必须能改**已签发**的授权，
 * 而不是让客户重新兑一张新码。改完之后 `entitlements_version` 自增，
 * 客户端下次心跳看到版本号变了就知道要重新拉 `/entitlements`。
 *
 * 三条硬约束：
 * 1. 只能覆盖产品里**已启用**的功能（`status = "active"`）——
 *    产品下线某个功能后，授权不能把它强行开回来，否则等于绕过运营下架。
 * 2. 值类型必须与功能定义一致（boolean / number / string），
 *    不做隐式转换：`"false"` 字符串塞进布尔功能会让客户端判断出错。
 * 3. `overrides` 是**全量替换**而不是增量合并：传空数组 = 清空所有覆盖，
 *    回落到套餐/产品默认值。这样前端不需要知道「删了哪一条」。
 */

const FEATURE_VALUE_TYPES = ["boolean", "number", "string"] as const;

export interface FeatureOverrideInput {
  code: string;
  value: unknown;
}

export interface UpdateFeatureOverridesResult {
  entitlementsVersion: number;
  snapshot: Record<string, unknown>;
  overrides: FeatureOverrideInput[];
}

/** 校验覆盖值与该功能声明的类型一致；不一致直接 422，不做隐式转换。 */
function assertFeatureValue(
  code: string,
  valueType: string,
  value: unknown,
): void {
  if (valueType === "boolean") {
    if (typeof value !== "boolean") {
      throw new ApiError(422, "FEATURE_VALUE_INVALID", `功能 ${code} 只接受布尔值`);
    }
    return;
  }
  if (valueType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ApiError(422, "FEATURE_VALUE_INVALID", `功能 ${code} 只接受数字`);
    }
    return;
  }
  if (valueType === "string") {
    if (typeof value !== "string" || value.length > 500) {
      throw new ApiError(422, "FEATURE_VALUE_INVALID", `功能 ${code} 只接受不超过 500 字的字符串`);
    }
    return;
  }
  // 未来新增的类型（如 json）先放行对象，避免加类型时把老逻辑锁死。
  if (value === null || typeof value !== "object") {
    throw new ApiError(422, "FEATURE_VALUE_INVALID", `功能 ${code} 的值类型 ${valueType} 需要传对象`);
  }
}

export async function updateLicenseFeatureOverrides(
  actor: ActorContext,
  licenseId: string,
  overrides: FeatureOverrideInput[],
): Promise<UpdateFeatureOverridesResult> {
  const license = await prisma.licenses.findFirst({
    where: { id: licenseId, organization_id: actor.organizationId, deleted_at: null },
    select: {
      id: true,
      product_id: true,
      plan_id: true,
      entitlements_version: true,
      feature_snapshot: true,
      products: { select: { name: true } },
    },
  });
  if (!license) throw new ApiError(404, "RESOURCE_NOT_FOUND", "授权不存在或不属于当前组织");

  // 去重：同一个 code 传两次以最后一条为准（前端多选框容易重复提交）。
  const deduped = new Map<string, unknown>();
  for (const item of overrides) {
    const code = item.code.trim();
    if (!code) throw new ApiError(422, "FEATURE_CODE_INVALID", "功能编码不能为空");
    deduped.set(code, item.value);
  }

  const definitions = await prisma.product_features.findMany({
    where: { product_id: license.product_id, organization_id: actor.organizationId },
    select: { code: true, value_type: true, status: true, name: true },
  });
  const byCode = new Map(definitions.map((row) => [row.code, row]));

  for (const [code, value] of deduped) {
    const definition = byCode.get(code);
    if (!definition) {
      throw new ApiError(422, "FEATURE_NOT_FOUND", `产品「${license.products.name}」没有定义功能 ${code}`);
    }
    if (definition.status !== "active") {
      throw new ApiError(
        422,
        "FEATURE_DISABLED",
        `功能「${definition.name}」已被产品停用，不能单独为授权开启`,
      );
    }
    assertFeatureValue(code, definition.value_type, value);
  }

  // 基线 = 产品默认值 + 套餐权限；覆盖值叠在最后。
  const baseline = await computeFeatureSnapshot(
    actor.organizationId,
    license.product_id,
    license.plan_id,
    undefined,
  );
  const snapshot: Record<string, unknown> = { ...baseline };
  for (const [code, value] of deduped) snapshot[code] = value;

  const beforeSnapshot = (license.feature_snapshot ?? {}) as Record<string, unknown>;

  const updated = await prisma.$transaction(async (tx) => {
    // 全量替换：先删掉不在本次列表里的覆盖行。
    await tx.license_features.deleteMany({
      where: {
        license_id: license.id,
        feature_code: { notIn: [...deduped.keys()] },
      },
    });
    for (const [code, value] of deduped) {
      await tx.license_features.upsert({
        where: { license_id_feature_code: { license_id: license.id, feature_code: code } },
        create: {
          license_id: license.id,
          product_id: license.product_id,
          organization_id: actor.organizationId,
          feature_code: code,
          feature_value: value as never,
        },
        update: { feature_value: value as never, updated_at: new Date() },
      });
    }
    return tx.licenses.update({
      where: { id: license.id },
      data: {
        feature_snapshot: snapshot as never,
        // 版本号是客户端判断「权限有没有变」的唯一依据，任何快照变更都必须 +1。
        entitlements_version: { increment: 1 },
        updated_at: new Date(),
      },
      select: { entitlements_version: true },
    });
  });

  await writeAudit({
    organizationId: actor.organizationId,
    actorType: "admin",
    actorId: actor.actorId,
    action: "license.features.update",
    resourceType: "license",
    resourceId: license.id,
    before: { feature_snapshot: beforeSnapshot, entitlements_version: license.entitlements_version },
    after: {
      feature_snapshot: snapshot,
      entitlements_version: updated.entitlements_version,
      overrides: Object.fromEntries(deduped),
    },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });

  return {
    entitlementsVersion: updated.entitlements_version,
    snapshot,
    overrides: [...deduped].map(([code, value]) => ({ code, value })),
  };
}
