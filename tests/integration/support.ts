import { generateKeyPairSync, sign } from "node:crypto";

/**
 * 集成测试：直接打真实 Next.js 服务与 PostgreSQL（不是 mock）。
 * 运行前：npm run db:seed && npm run dev（或 npm run build && npm start）
 * 运行：npm run test:integration
 */

export const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
export const PUBLIC_CLIENT_ID = process.env.TEST_PUBLIC_CLIENT_ID ?? "pc_desktop_7d3c1a9b4e2f";

export interface Session {
  cookie: string;
  csrf: string;
}

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  json: { ok: boolean; code: string; message?: string; data?: T } & Record<string, unknown>;
  headers: Headers;
}

/**
 * 会话缓存：登录接口有 8 次/5 分钟的限流（429 RATE_LIMITED），
 * 同一账号在整个测试文件里只登录一次，避免测试自身触发限流。
 */
const sessionCache = new Map<string, Session>();

export async function login(email: string, password: string): Promise<Session> {
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookies = response.headers.getSetCookie();
  let cookie = "";
  let csrf = "";
  for (const item of cookies) {
    const [pair] = item.split(";");
    const [name, value] = pair.split("=");
    if (name === "lic_session") cookie = `lic_session=${value}`;
    if (name === "lic_csrf") csrf = value;
  }
  if (!cookie || !csrf) throw new Error(`登录失败：${response.status} ${await response.text()}`);
  const session = { cookie, csrf };
  sessionCache.set(email, session);
  return session;
}

export function adminFetch(session: Session | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers["content-type"] = "application/json";
  if (session) {
    headers.cookie = `${session.cookie}; lic_csrf=${session.csrf}`;
    if ((init.method ?? "GET") !== "GET") headers["x-csrf-token"] = session.csrf;
  }
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export async function adminJson<T>(session: Session | null, path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await adminFetch(session, path, init);
  return { status: response.status, json: (await response.json()) as never, headers: response.headers };
}

export async function publicJson<T>(path: string, init: {
  method?: string;
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
} = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "x-client-id": PUBLIC_CLIENT_ID };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const response = await fetch(`${BASE}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, json: (await response.json()) as never, headers: response.headers };
}

export const b64url = (value: Buffer) => value.toString("base64url");

export interface DesktopContext {
  productId: string;
  customerId: string;
  planId: string;
}

export async function desktopContext(session: Session): Promise<DesktopContext> {
  const lookups = await adminJson<{
    products: Array<{ id: string; code: string }>;
    customers: Array<{ id: string }>;
    plans: Array<{ id: string; productId: string }>;
  }>(session, "/api/v1/admin/lookups");
  const desktop = lookups.json.data!.products.find((product) => product.code === "fluxpanel-desktop");
  if (!desktop) throw new Error("种子数据缺少 FluxPanel 桌面版产品");
  const plan = lookups.json.data!.plans.find((item) => item.productId === desktop.id);
  return {
    productId: desktop.id,
    customerId: lookups.json.data!.customers[0].id,
    planId: plan?.id ?? "",
  };
}

export async function issueLicense(
  session: Session,
  context: DesktopContext,
  overrides: Record<string, unknown> = {},
) {
  const result = await adminJson<{ id: string; licenseKey: string; expiresAt: string | null }>(
    session,
    "/api/v1/admin/licenses",
    {
      method: "POST",
      body: JSON.stringify({
        productId: context.productId,
        customerId: context.customerId,
        duration: { unit: "day", value: 30 },
        startPolicy: "on_first_activation",
        maxDevices: 2,
        maxActivationCount: 5,
        notes: `集成测试 ${new Date().toISOString()}`,
        ...overrides,
      }),
    },
  );
  if (result.status !== 201) throw new Error(`签发失败：${JSON.stringify(result.json)}`);
  return result.json.data!;
}

/** 完整执行一次设备挑战 + Ed25519 签名，返回激活请求体。 */
export async function prepareActivation(licenseKey: string, tag: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = b64url(publicKey.export({ type: "spki", format: "der" }));
  const instanceId = `install_it_${tag}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;

  const challenge = await publicJson<{
    challenge_id: string;
    nonce: string;
    expires_at: string;
    canonical_message: string;
  }>("/api/v1/activation-challenges", {
    body: {
      device: {
        device_instance_id: instanceId,
        platform: "windows",
        device_name: `IT-${tag}`,
        public_key: publicKeyB64,
      },
    },
  });
  if (challenge.status !== 200) throw new Error(`挑战失败：${JSON.stringify(challenge.json)}`);
  const data = challenge.json.data!;
  const signature = b64url(sign(null, Buffer.from(data.canonical_message, "utf8"), privateKey));
  return {
    instanceId,
    publicKeyB64,
    body: {
      license_key: licenseKey,
      challenge_id: data.challenge_id,
      device: {
        device_instance_id: instanceId,
        platform: "windows",
        device_name: `IT-${tag}`,
        public_key: publicKeyB64,
      },
      signature,
      client_version: "2.0.7",
    },
  };
}
