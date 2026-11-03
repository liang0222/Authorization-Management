import { createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError, apiError } from "@/lib/http/api";
import { addDuration, formatDuration } from "@/lib/domain/period";
import { computeEffectiveState } from "@/lib/domain/effective-status";
import {
  canonicalChallengeMessageFor,
  canonicalChallengeMessageV1,
  issueActivationToken,
  type CanonicalVersion,
} from "@/lib/domain/activation-token";
import { locateLicenseKey } from "@/lib/services/license-key-lookup";
import { config } from "@/lib/config";
import { enqueueWebhook } from "@/lib/services/webhook-events";
import {
  hashRefreshToken,
  issueRefreshToken,
  revokeRefreshTokensForActivation,
  rotateRefreshToken,
} from "@/lib/services/refresh-tokens";

/** 心跳建议间隔（规格 4.7 `heartbeat_interval_seconds`）。 */
const HEARTBEAT_INTERVAL_SECONDS = 900;
/** refresh token 有效期：与授权周期解耦，默认 30 天，允许客户端长期免重激活。 */
const REFRESH_TTL_SECONDS = 30 * 24 * 3600;

/**
 * 公开客户端授权链路（规格 3.4 / 4.6 / 4.7 / 4.8 / 4.9 / 4.10）。
 *
 * 关键约束：
 * - 首次激活必须在单事务内 SELECT ... FOR UPDATE 锁定 License 行，否则并发会突破设备上限。
 * - 起算时间由服务器决定，客户端时间不参与过期判定。
 * - 令牌只存版本，轮换后旧令牌立即失效。
 */

export interface PublicClient {
  organizationId: string;
  productId: string;
  clientId: string;
  credentialId: string;
  productStatus: "active" | "disabled" | "archived";
  accessTokenTtlSeconds: number;
}

export async function resolvePublicClient(clientId: string | null): Promise<PublicClient> {
  if (!clientId) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "缺少 X-Client-ID");
  }
  const credential = await prisma.product_credentials.findUnique({
    where: { client_id: clientId },
    include: { products: true },
  });
  // 凭证绑定部署环境（规格 27.3）：Sandbox 的 client_id 拿到生产调用必须失败，
  // 否则两套环境共用凭证，「隔离」只是文案。
  if (!credential || credential.status !== "active" || credential.environment !== config.credentialEnvironment) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "客户端标识无效或已停用");
  }
  if (credential.products.status !== "active") {
    throw new ApiError(403, "PRODUCT_DISABLED", "产品已禁用");
  }
  return {
    organizationId: credential.organization_id,
    productId: credential.product_id,
    clientId: credential.client_id,
    credentialId: credential.id,
    productStatus: credential.products.status,
    accessTokenTtlSeconds: credential.products.access_token_ttl_seconds,
  };
}

async function assertScope(client: PublicClient, scope: string): Promise<void> {
  const credential = await prisma.product_credentials.findUnique({
    where: { id: client.credentialId },
    select: { scopes: true },
  });
  if (!credential?.scopes.includes(scope)) {
    // 凭证是有效的，只是没有这个 scope —— 属授权问题而非认证失败。
    // 用 FORBIDDEN 才能让「一个 code 一个状态码」成立（CLIENT_AUTH_FAILED 固定 401）。
    throw apiError("FORBIDDEN", `该客户端缺少 scope：${scope}`);
  }
}

/** 1. 创建设备挑战（nonce 一次性消费，5 分钟有效）。 */
export async function createChallenge(
  client: PublicClient,
  input: {
    deviceInstanceId: string;
    platform: string;
    deviceName: string | null;
    publicKey: string;
  },
) {
  await assertScope(client, "activation:create");
  let publicKeyDer: Buffer;
  try {
    publicKeyDer = Buffer.from(input.publicKey, "base64url");
    createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", "public_key 必须是 base64url 编码的 Ed25519 SPKI 公钥");
  }

  const challengeId = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 5 * 60_000);

  await prisma.activation_challenges.create({
    data: {
      organization_id: client.organizationId,
      product_id: client.productId,
      challenge_id: challengeId,
      nonce,
      device_instance_id: input.deviceInstanceId,
      expires_at: expiresAt,
    },
  });

  return {
    challenge_id: challengeId,
    nonce,
    expires_at: expiresAt.toISOString(),
    signing_algorithm: "Ed25519" as const,
    /**
     * 规范化消息版本（规格 27.8）。
     * `canonical_message` 返回 v1（带 `LICENSE-ACTIVATION-CHALLENGE-V1` 前缀）。
     * 老客户端若自行按 5 字段拼接，服务端仍然接受（见 activate 的双版本验签）。
     */
    canonical_version: "v1" as const,
    canonical_message: canonicalChallengeMessageV1({
      challengeId,
      nonce,
      productId: client.productId,
      deviceInstanceId: input.deviceInstanceId,
      expiresAt: expiresAt.toISOString(),
    }),
  };
}

export interface ActivateInput {
  licenseKey: string;
  challengeId: string;
  deviceInstanceId: string;
  platform: string;
  deviceName: string | null;
  publicKey: string;
  signature: string;
  clientVersion: string | null;
  /** 客户端声明的规范化消息版本；不传则先 v1 后 legacy 依次尝试。 */
  canonicalVersion?: CanonicalVersion | null;
  ip: string | null;
}

function verifyChallengeSignature(input: {
  publicKeyDer: Buffer;
  message: string;
  signature: string;
}): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(input.message, "utf8"),
      createPublicKey({ key: input.publicKeyDer, format: "der", type: "spki" }),
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** 2. 首次激活：校验挑战签名 + 事务内锁行 + 计数/设备上限检查。 */
export interface ActivationResponse {
  activation_id: string;
  license_id: string;
  product_id: string;
  effective_status: string;
  starts_at: string | null;
  expires_at: string | null;
  duration: { unit: string; value: number; label: string };
  device_limit: { max: number; active: number };
  activation_limit: { max: number | null; used: number };
  entitlements: Record<string, unknown>;
  entitlements_version: number;
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  heartbeat_interval_seconds: number;
  /** v1.4 兼容字段：老客户端继续读这几个键。 */
  token_expires_at: string;
  token_type: "Bearer";
  license: Record<string, unknown>;
}

export async function activate(
  client: PublicClient,
  input: ActivateInput,
): Promise<ActivationResponse> {
  await assertScope(client, "activation:create");

  const challenge = await prisma.activation_challenges.findUnique({
    where: { challenge_id: input.challengeId },
  });
  if (!challenge || challenge.organization_id !== client.organizationId) {
    throw new ApiError(400, "INVALID_REQUEST", "设备挑战不存在");
  }
  if (challenge.consumed_at) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "设备挑战已被消费，请重新申请");
  }
  if (challenge.expires_at.getTime() <= Date.now()) {
    throw new ApiError(410, "ACTIVATION_WINDOW_EXPIRED", "设备挑战已过期，请重新申请");
  }
  if (challenge.product_id !== client.productId || challenge.device_instance_id !== input.deviceInstanceId) {
    throw new ApiError(400, "INVALID_REQUEST", "挑战与产品/设备不匹配");
  }

  const publicKeyDer = Buffer.from(input.publicKey, "base64url");
  const messageInput = {
    challengeId: challenge.challenge_id,
    nonce: challenge.nonce,
    productId: client.productId,
    deviceInstanceId: input.deviceInstanceId,
    expiresAt: challenge.expires_at.toISOString(),
  };
  // 双版本验签：声明了版本就只用该版本，否则 v1 优先、legacy 兜底。
  // 这样 v1.4 客户端（5 字段）与 v1.5 SDK（带前缀）能同时工作。
  const candidates: CanonicalVersion[] = input.canonicalVersion
    ? [input.canonicalVersion]
    : ["v1", "legacy"];
  const signatureOk = candidates.some((version) =>
    verifyChallengeSignature({
      publicKeyDer,
      message: canonicalChallengeMessageFor(version, messageInput),
      signature: input.signature,
    }),
  );
  if (!signatureOk) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "设备签名校验失败");
  }

  // pepper 轮换：命中旧 pepper 会在这一步就地重哈希（见 locateLicenseKey）。
  const located = await locateLicenseKey(input.licenseKey);
  const licenseKeyRow = located
    ? await prisma.license_keys.findUnique({
        where: { id: located.id },
        include: {
          licenses: {
            include: { products: true, customers: true },
          },
        },
      })
    : null;
  if (!licenseKeyRow || licenseKeyRow.status !== "active" || licenseKeyRow.revoked_at) {
    throw new ApiError(422, "LICENSE_INVALID", "授权码无效或已撤销");
  }
  if (licenseKeyRow.organization_id !== client.organizationId) {
    throw new ApiError(422, "LICENSE_INVALID", "授权码无效");
  }
  const license = licenseKeyRow.licenses;
  if (license.product_id !== client.productId) {
    throw new ApiError(422, "PRODUCT_MISMATCH", "授权不属于该产品");
  }
  if (license.deleted_at) {
    throw new ApiError(422, "LICENSE_INVALID", "授权已作废");
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    // 锁定 License 行：并发激活必须串行化，否则两个请求可能同时通过设备上限检查
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM licenses WHERE id = ${license.id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw new ApiError(422, "LICENSE_INVALID", "授权不存在");

    const fresh = await tx.licenses.findUnique({
      where: { id: license.id },
      include: { products: true },
    });
    if (!fresh) throw new ApiError(422, "LICENSE_INVALID", "授权不存在");

    const activeCount = await tx.activations.count({
      where: { license_id: license.id, status: "active" },
    });
    const state = computeEffectiveState(
      {
        adminStatus: fresh.admin_status,
        productStatus: fresh.products.status,
        startsAt: fresh.starts_at,
        expiresAt: fresh.expires_at,
        activationDeadlineAt: fresh.activation_deadline_at,
        hasActivated: fresh.activation_count > 0 || fresh.starts_at !== null,
        activeDeviceCount: activeCount,
        maxDevices: fresh.max_devices,
        activationCount: fresh.activation_count,
        maxActivationCount: fresh.max_activation_count,
      },
      now,
    );
    if (!state.canActivate) {
      throw apiError(
        state.activationBlockReason ?? "LICENSE_INVALID",
        state.reason,
        { effective_status: state.status },
      );
    }

    // 同一设备已绑定同一授权：幂等返回原激活记录，不重复消耗次数
    const existing = await tx.activations.findFirst({
      where: {
        license_id: license.id,
        status: "active",
        devices: { device_instance_id: input.deviceInstanceId },
      },
      include: { devices: true },
    });
    if (existing) {
      const rotated = await tx.activations.update({
        where: { id: existing.id },
        data: { token_version: { increment: 1 }, last_seen_at: now },
      });
      await tx.activation_challenges.update({
        where: { id: challenge.id },
        data: { consumed_at: now },
      });
      const refresh = await issueRefreshToken(tx, {
        organizationId: client.organizationId,
        activationId: rotated.id,
        ttlSeconds: REFRESH_TTL_SECONDS,
      });
      return {
        activation: rotated,
        deviceId: existing.device_id,
        reused: true,
        startsAt: fresh.starts_at,
        expiresAt: fresh.expires_at,
        refresh,
        activeDevices: activeCount,
        entitlementsVersion: fresh.entitlements_version,
      };
    }

    // 首次激活：写入 starts_at / expires_at（由服务器时间决定）
    let startsAt = fresh.starts_at;
    let expiresAt = fresh.expires_at;
    if (fresh.start_policy === "on_first_activation" && startsAt === null) {
      startsAt = now;
      expiresAt = addDuration(
        now,
        { unit: fresh.duration_unit, value: fresh.duration_value },
        fresh.timezone,
      );
    }

    const device = await tx.devices.upsert({
      where: {
        product_id_device_instance_id: {
          product_id: client.productId,
          device_instance_id: input.deviceInstanceId,
        },
      },
      update: {
        device_name: input.deviceName,
        platform: input.platform,
        public_key: publicKeyDer,
        last_seen_at: now,
      },
      create: {
        organization_id: client.organizationId,
        product_id: client.productId,
        device_instance_id: input.deviceInstanceId,
        platform: input.platform,
        device_name: input.deviceName,
        public_key: publicKeyDer,
        first_seen_at: now,
        last_seen_at: now,
      },
    });

    // 产品级约束：同一设备不能同时绑定同产品下的两份有效授权
    const conflicting = await tx.activations.findFirst({
      where: {
        product_id: client.productId,
        device_id: device.id,
        status: "active",
        license_id: { not: license.id },
      },
    });
    if (conflicting) {
      throw new ApiError(409, "LICENSE_ALREADY_BOUND", "该设备已绑定本产品的其他授权，请先解绑");
    }

    const activation = await tx.activations.create({
      data: {
        organization_id: client.organizationId,
        product_id: client.productId,
        license_id: license.id,
        device_id: device.id,
        status: "active",
        activated_at: now,
        last_seen_at: now,
        client_version: input.clientVersion,
        last_ip: input.ip,
      },
    });

    await tx.licenses.update({
      where: { id: license.id },
      data: {
        activation_count: { increment: 1 },
        starts_at: startsAt,
        expires_at: expiresAt,
        admin_status: fresh.admin_status === "pending" ? "active" : fresh.admin_status,
      },
    });

    if (!licenseKeyRow.first_redeemed_at) {
      await tx.license_keys.update({
        where: { id: licenseKeyRow.id },
        data: { first_redeemed_at: now },
      });
    }

    await tx.activation_challenges.update({
      where: { id: challenge.id },
      data: { consumed_at: now },
    });

    await tx.activation_events.create({
      data: {
        organization_id: client.organizationId,
        activation_id: activation.id,
        event_type: "activation.created",
        actor_type: "client",
        ip: input.ip,
        details: { platform: input.platform, client_version: input.clientVersion },
      },
    });

    const refresh = await issueRefreshToken(tx, {
      organizationId: client.organizationId,
      activationId: activation.id,
      ttlSeconds: REFRESH_TTL_SECONDS,
    });

    return {
      activation,
      deviceId: device.id,
      reused: false,
      startsAt,
      expiresAt,
      refresh,
      activeDevices: activeCount + 1,
      entitlementsVersion: fresh.entitlements_version,
    };
  });

  const token = issueActivationToken(
    {
      aid: result.activation.id,
      did: result.deviceId,
      pid: client.productId,
      org: client.organizationId,
      ver: result.activation.token_version,
    },
    client.accessTokenTtlSeconds,
  );

  await enqueueWebhook(client.organizationId, "activation.created", {
    activation_id: result.activation.id,
    license_id: license.id,
    device_id: result.deviceId,
    occurred_at: now.toISOString(),
  });
  await enqueueWebhook(client.organizationId, "license.activated", {
    license_id: license.id,
    activation_id: result.activation.id,
    occurred_at: now.toISOString(),
  });

  const duration = { unit: license.duration_unit, value: license.duration_value };
  const entitlements = (license.feature_snapshot ?? {}) as Record<string, unknown>;

  return {
    // ---- v1.5 规范字段（规格 4.7）----
    activation_id: result.activation.id,
    license_id: license.id,
    product_id: client.productId,
    effective_status: "active",
    starts_at: result.startsAt?.toISOString() ?? null,
    expires_at: result.expiresAt?.toISOString() ?? null,
    duration: { ...duration, label: formatDuration(duration) },
    device_limit: { max: license.max_devices, active: result.activeDevices },
    activation_limit: {
      max: license.max_activation_count,
      used: result.reused ? license.activation_count : license.activation_count + 1,
    },
    entitlements,
    entitlements_version: result.entitlementsVersion,
    access_token: token.token,
    access_token_expires_at: token.expiresAt.toISOString(),
    refresh_token: result.refresh.token,
    refresh_token_expires_at: result.refresh.expiresAt.toISOString(),
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    // ---- v1.4 兼容字段（保持原键名与语义）----
    token_expires_at: token.expiresAt.toISOString(),
    token_type: "Bearer",
    license: {
      id: license.id,
      admin_status: result.reused ? license.admin_status : "active",
      starts_at: result.startsAt?.toISOString() ?? null,
      expires_at: result.expiresAt?.toISOString() ?? null,
      duration,
      max_devices: license.max_devices,
      offline_allowed: license.offline_allowed,
      offline_grace_seconds: license.offline_grace_seconds,
    },
  };
}

export interface HeartbeatResponse {
  effective_status: string;
  expires_at: string | null;
  entitlements_version: number;
  entitlements: Record<string, unknown>;
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string | null;
  refresh_token_expires_at: string | null;
  next_heartbeat_seconds: number;
  /** v1.4 兼容字段。 */
  token_expires_at: string;
  token_type: "Bearer";
  license: Record<string, unknown>;
}

/**
 * 3. 心跳核心：状态检查 + 令牌版本递增 + 可选 refresh token 轮换。
 *
 * 规格 4.8 要求「旧 refresh token 不可再次使用；检测到重放时撤销该激活会话并写安全事件」，
 * 这部分由 `rotateRefreshToken` 负责（同族吊销 + activation.blocked 事件）。
 */
async function coreHeartbeat(
  activationId: string,
  organizationId: string,
  options: { refreshToken?: string | null } = {},
): Promise<HeartbeatResponse> {
  const activation = await prisma.activations.findFirst({
    where: { id: activationId, organization_id: organizationId },
    include: { licenses: { include: { products: true } }, devices: true },
  });
  if (!activation || activation.status === "released" || activation.status === "revoked") {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "激活记录已失效");
  }
  if (activation.status === "blocked") {
    throw new ApiError(423, "DEVICE_BLOCKED", "设备已被管理员禁用");
  }

  const now = new Date();
  const activeCount = await prisma.activations.count({
    where: { license_id: activation.license_id, status: "active" },
  });
  const state = computeEffectiveState(
    {
      adminStatus: activation.licenses.admin_status,
      productStatus: activation.licenses.products.status,
      startsAt: activation.licenses.starts_at,
      expiresAt: activation.licenses.expires_at,
      activationDeadlineAt: activation.licenses.activation_deadline_at,
      hasActivated: true,
      activeDeviceCount: activeCount,
      maxDevices: activation.licenses.max_devices,
      activationCount: activation.licenses.activation_count,
      maxActivationCount: activation.licenses.max_activation_count,
    },
    now,
  );
  if (!state.usable) {
    throw apiError(
      state.activationBlockReason ?? "LICENSE_INVALID",
      state.reason,
      { effective_status: state.status },
    );
  }

  const ttlSeconds = 600;
  const result = await prisma.$transaction(async (tx) => {
    // 每次心跳都轮换 refresh token：旧令牌立即失效，泄露窗口只有一个心跳周期。
    let refresh: { token: string; expiresAt: Date } | null = null;
    if (options.refreshToken) {
      const rotated = await rotateRefreshToken(tx, {
        token: options.refreshToken,
        organizationId,
        ttlSeconds: REFRESH_TTL_SECONDS,
      });
      if (!rotated.ok) {
        // 不能在这里 throw：重放时要先让「整族吊销」提交，否则事务回滚会把吊销一起撤销。
        return { updated: null, refresh: null, failure: rotated.reason };
      }
      if (rotated.activationId !== activation.id) {
        return { updated: null, refresh: null, failure: "invalid" as const };
      }
      refresh = { token: rotated.token, expiresAt: rotated.expiresAt };
    }

    const updated = await tx.activations.update({
      where: { id: activation.id },
      data: { last_seen_at: now, token_version: { increment: 1 } },
    });

    return { updated, refresh, failure: null };
  });

  if (!result.updated) {
    const message =
      result.failure === "replay"
        ? "refresh_token 已使用过，存在重放风险，令牌族已吊销"
        : result.failure === "expired"
          ? "refresh_token 已过期，请重新激活"
          : result.failure === "revoked"
            ? "refresh_token 已被吊销，请重新激活"
            : "refresh_token 无效";
    throw new ApiError(401, "CLIENT_AUTH_FAILED", message);
  }

  const token = issueActivationToken(
    {
      aid: activation.id,
      did: activation.device_id,
      pid: activation.product_id,
      org: activation.organization_id,
      ver: result.updated.token_version,
    },
    ttlSeconds,
  );

  return {
    // ---- v1.5 规范字段（规格 4.8）----
    effective_status: state.status,
    expires_at: activation.licenses.expires_at?.toISOString() ?? null,
    entitlements_version: activation.licenses.entitlements_version,
    entitlements: (activation.licenses.feature_snapshot ?? {}) as Record<string, unknown>,
    access_token: token.token,
    access_token_expires_at: token.expiresAt.toISOString(),
    refresh_token: result.refresh?.token ?? null,
    refresh_token_expires_at: result.refresh?.expiresAt.toISOString() ?? null,
    next_heartbeat_seconds: HEARTBEAT_INTERVAL_SECONDS,
    // ---- v1.4 兼容字段 ----
    token_expires_at: token.expiresAt.toISOString(),
    token_type: "Bearer",
    license: {
      id: activation.licenses.id,
      effective_status: state.status,
      expires_at: activation.licenses.expires_at?.toISOString() ?? null,
    },
  };
}

/** 3a. Bearer 令牌心跳（v1.4 通道）：校验令牌版本后轮换访问令牌。 */
export async function heartbeat(tokenPayload: {
  aid: string;
  did: string;
  pid: string;
  org: string;
  ver: number;
}): Promise<HeartbeatResponse> {
  const activation = await prisma.activations.findFirst({
    where: { id: tokenPayload.aid, organization_id: tokenPayload.org },
    select: { id: true, token_version: true },
  });
  if (!activation) throw new ApiError(401, "CLIENT_AUTH_FAILED", "激活记录已失效");
  if (activation.token_version !== tokenPayload.ver) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "令牌已被轮换，请使用最新令牌");
  }
  return coreHeartbeat(tokenPayload.aid, tokenPayload.org);
}

/** 3b. refresh token 心跳（v1.5 通道）：轮换 refresh token 并返回新访问令牌。 */
export async function heartbeatWithRefreshToken(refreshToken: string): Promise<HeartbeatResponse> {
  const row = await prisma.activation_refresh_tokens.findUnique({
    where: { token_hash: hashRefreshToken(refreshToken) },
    select: { organization_id: true, activation_id: true },
  });
  if (!row) throw new ApiError(401, "CLIENT_AUTH_FAILED", "refresh_token 无效");
  return coreHeartbeat(row.activation_id, row.organization_id, { refreshToken });
}

export interface DeactivateResponse {
  activation_id: string;
  status: "released";
  device_slot_released: boolean;
  /** v1.4 兼容字段。 */
  released: boolean;
  activationCount: number;
}

/** 4. 主动解绑：释放设备名额（默认不返还累计激活次数），并吊销该激活的 refresh token。 */
async function releaseActivation(
  activationId: string,
  organizationId: string,
  reason: string | null,
): Promise<DeactivateResponse> {
  const activation = await prisma.activations.findFirst({
    where: { id: activationId, organization_id: organizationId },
    include: { licenses: true },
  });
  if (!activation) throw new ApiError(404, "RESOURCE_NOT_FOUND", "激活记录不存在");
  if (activation.status !== "active") {
    // 重复解绑幂等：已经是 released/revoked 时直接返回，不再写事件。
    return {
      activation_id: activation.id,
      status: "released",
      device_slot_released: false,
      released: activation.status === "released",
      activationCount: activation.licenses.activation_count,
    };
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${activation.license_id}::uuid FOR UPDATE`;
    await tx.activations.update({
      where: { id: activation.id },
      data: { status: "released", released_at: now, token_version: { increment: 1 } },
    });
    await revokeRefreshTokensForActivation(tx, {
      organizationId: activation.organization_id,
      activationId: activation.id,
    });
    let activationCount = activation.licenses.activation_count;
    if (activation.licenses.refund_activation_on_release) {
      activationCount = Math.max(0, activationCount - 1);
      await tx.licenses.update({
        where: { id: activation.license_id },
        data: { activation_count: activationCount },
      });
    }
    await tx.activation_events.create({
      data: {
        organization_id: activation.organization_id,
        activation_id: activation.id,
        event_type: "activation.released",
        actor_type: "client",
        details: { reason },
      },
    });
    return { activationCount };
  });

  await enqueueWebhook(activation.organization_id, "activation.released", {
    activation_id: activation.id,
    license_id: activation.license_id,
    occurred_at: now.toISOString(),
  });

  return {
    activation_id: activation.id,
    status: "released",
    device_slot_released: true,
    released: true,
    activationCount: result.activationCount,
  };
}

/** 4a. Bearer 令牌解绑（v1.4 通道）。 */
export async function deactivate(
  tokenPayload: { aid: string; org: string; ver: number },
  reason: string | null,
): Promise<DeactivateResponse> {
  const activation = await prisma.activations.findFirst({
    where: { id: tokenPayload.aid, organization_id: tokenPayload.org },
    select: { id: true, token_version: true },
  });
  if (!activation) throw new ApiError(404, "RESOURCE_NOT_FOUND", "激活记录不存在");
  if (activation.token_version !== tokenPayload.ver) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "令牌已被轮换");
  }
  return releaseActivation(tokenPayload.aid, tokenPayload.org, reason);
}

/** 4b. refresh token 解绑（v1.5 通道）：规格 4.9 的请求体只有 refresh_token。 */
export async function deactivateWithRefreshToken(
  refreshToken: string,
  reason: string | null,
): Promise<DeactivateResponse> {
  const row = await prisma.activation_refresh_tokens.findUnique({
    where: { token_hash: hashRefreshToken(refreshToken) },
    select: { organization_id: true, activation_id: true, used_at: true, revoked_at: true, expires_at: true },
  });
  if (!row) throw new ApiError(401, "CLIENT_AUTH_FAILED", "refresh_token 无效");
  if (row.revoked_at || row.expires_at.getTime() <= Date.now()) {
    throw new ApiError(401, "CLIENT_AUTH_FAILED", "refresh_token 已失效");
  }
  const result = await releaseActivation(row.activation_id, row.organization_id, reason);
  return result;
}

/** 5. 查询功能权限（含产品默认值合并顺序）。 */
export async function entitlementsFor(tokenPayload: { aid: string; org: string }) {
  const activation = await prisma.activations.findFirst({
    where: { id: tokenPayload.aid, organization_id: tokenPayload.org },
    include: { licenses: { include: { products: true } } },
  });
  if (!activation) throw new ApiError(404, "RESOURCE_NOT_FOUND", "激活记录不存在");
  const activeCount = await prisma.activations.count({
    where: { license_id: activation.license_id, status: "active" },
  });
  // 权限快照的有效性取决于授权本身，这里按 3.2 的优先级重算，而不是直接抄 admin_status。
  const state = computeEffectiveState(
    {
      adminStatus: activation.licenses.admin_status,
      productStatus: activation.licenses.products.status,
      startsAt: activation.licenses.starts_at,
      expiresAt: activation.licenses.expires_at,
      activationDeadlineAt: activation.licenses.activation_deadline_at,
      hasActivated: true,
      activeDeviceCount: activeCount,
      maxDevices: activation.licenses.max_devices,
      activationCount: activation.licenses.activation_count,
      maxActivationCount: activation.licenses.max_activation_count,
    },
    new Date(),
  );
  if (!state.usable) {
    throw apiError(
      state.activationBlockReason ?? "LICENSE_INVALID",
      state.reason,
      { effective_status: state.status },
    );
  }
  return {
    license_id: activation.license_id,
    activation_id: activation.id,
    effective_status: state.status,
    expires_at: activation.licenses.expires_at?.toISOString() ?? null,
    entitlements_version: activation.licenses.entitlements_version,
    entitlements: (activation.licenses.feature_snapshot ?? {}) as Record<string, unknown>,
    // v1.4 兼容：老 SDK 读 features。
    features: (activation.licenses.feature_snapshot ?? {}) as Record<string, unknown>,
  };
}

/** 非绑定预检查：只判断授权码是否可用，不创建激活记录。 */
export async function validateLicenseKey(client: PublicClient, licenseKey: string) {
  await assertScope(client, "license:validate");
  const located = await locateLicenseKey(licenseKey);
  const row = located
    ? await prisma.license_keys.findUnique({
        where: { id: located.id },
        include: { licenses: { include: { products: true } } },
      })
    : null;
  if (!row || row.status !== "active" || row.organization_id !== client.organizationId) {
    return { valid: false, code: "LICENSE_INVALID" as const };
  }
  const license = row.licenses;
  if (license.product_id !== client.productId) {
    return { valid: false, code: "PRODUCT_MISMATCH" as const };
  }
  const activeCount = await prisma.activations.count({
    where: { license_id: license.id, status: "active" },
  });
  const state = computeEffectiveState(
    {
      adminStatus: license.admin_status,
      productStatus: license.products.status,
      startsAt: license.starts_at,
      expiresAt: license.expires_at,
      activationDeadlineAt: license.activation_deadline_at,
      hasActivated: license.activation_count > 0 || license.starts_at !== null,
      activeDeviceCount: activeCount,
      maxDevices: license.max_devices,
      activationCount: license.activation_count,
      maxActivationCount: license.max_activation_count,
    },
    new Date(),
  );
  return {
    valid: state.usable && state.canActivate,
    code: state.canActivate ? ("OK" as const) : (state.activationBlockReason ?? "LICENSE_INVALID"),
    effective_status: state.status,
    duration: { unit: license.duration_unit, value: license.duration_value },
    max_devices: license.max_devices,
    active_devices: activeCount,
    offline_allowed: license.offline_allowed,
  };
}

/** 触发 Webhook 投递（写入 pending 记录，由后台投递器处理）。 */
