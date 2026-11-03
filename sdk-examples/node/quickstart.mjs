/**
 * 子铭软件授权 API · Node.js 示例（只依赖标准库，Node 18+）
 *
 * 成功路径：挑战 → 签名 → 激活 → 心跳
 * 失败路径：无效授权码 → 422 LICENSE_INVALID → LicenseRejectedError
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.LICENSE_BASE_URL ?? "https://<LICENSE_SANDBOX_DOMAIN>/api/v1").replace(/\/$/, "");
const CLIENT_ID = process.env.LICENSE_CLIENT_ID ?? "";
const PRODUCT_ID = process.env.LICENSE_PRODUCT_ID ?? "";
const LICENSE_KEY = process.env.LICENSE_KEY ?? "";
const KEY_DIR = process.env.LICENSE_KEY_DIR ?? tmpdir();

class LicenseError extends Error {
  constructor(code, message, { requestId = null, status = null } = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}
class LicenseRejectedError extends LicenseError {}
class LicenseSuspendedError extends LicenseError {}
class LicenseExpiredError extends LicenseError {}
class DeviceLimitError extends LicenseError {}
class ActivationLimitError extends LicenseError {}
class RateLimitError extends LicenseError {}
class ServiceDownError extends LicenseError {}
class AuthenticationError extends LicenseError {}

const ERROR_MAP = {
  CLIENT_AUTH_FAILED: AuthenticationError,
  // 公开 API 里 FORBIDDEN 只来自凭证缺少某个 scope，属接入配置问题。
  FORBIDDEN: AuthenticationError,
  LICENSE_INVALID: LicenseRejectedError,
  // 产品被停用：该产品下所有授权同时不可用，不是单张授权的问题。
  PRODUCT_DISABLED: LicenseRejectedError,
  PRODUCT_MISMATCH: LicenseRejectedError,
  LICENSE_EXPIRED: LicenseExpiredError,
  ACTIVATION_WINDOW_EXPIRED: LicenseExpiredError,
  LICENSE_SUSPENDED: LicenseSuspendedError,
  DEVICE_BLOCKED: LicenseSuspendedError,
  DEVICE_LIMIT_EXCEEDED: DeviceLimitError,
  ACTIVATION_LIMIT_REACHED: ActivationLimitError,
  RATE_LIMITED: RateLimitError,
  LICENSE_SERVICE_UNAVAILABLE: ServiceDownError,
};

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");

async function call(path, payload, headers = {}) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-client-id": CLIENT_ID,
      "x-sdk-version": "node-example/1.5.0",
      ...headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const ErrorClass = ERROR_MAP[body.code] ?? LicenseError;
    throw new ErrorClass(body.code, body.message, { requestId: body.request_id, status: response.status });
  }
  return body.data;
}

function loadDeviceKey() {
  mkdirSync(KEY_DIR, { recursive: true });
  const path = join(KEY_DIR, "ziming-example-device.pem");
  if (existsSync(path)) return createPrivateKey(readFileSync(path));
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  return privateKey;
}

const publicKeyB64 = (privateKey) =>
  b64(createPublicKey(privateKey).export({ type: "spki", format: "der" }));

async function activate(privateKey, licenseKey, deviceId) {
  const device = {
    device_instance_id: deviceId,
    platform: "linux",
    device_name: "Example Host",
    public_key: publicKeyB64(privateKey),
  };
  const challenge = await call("/activation-challenges", { product_id: PRODUCT_ID, device });
  const signature = b64(sign(null, Buffer.from(challenge.canonical_message), privateKey));
  return call(
    "/activations",
    {
      product_id: PRODUCT_ID,
      license_key: licenseKey,
      challenge_id: challenge.challenge_id,
      device: { ...device, signature },
      client: { app_version: "1.5.0", sdk_version: "node-example" },
    },
    { "idempotency-key": `activate-${deviceId}-${licenseKey.slice(-4)}` },
  );
}

async function main() {
  const missing = [];
  // 示例不再内置任何真实 client_id：必须由使用者从后台创建凭证后传入。
  if (!process.env.LICENSE_BASE_URL) missing.push("LICENSE_BASE_URL");
  if (!CLIENT_ID) missing.push("LICENSE_CLIENT_ID");
  if (!PRODUCT_ID) missing.push("LICENSE_PRODUCT_ID");
  if (!LICENSE_KEY) missing.push("LICENSE_KEY");
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(", ")}`);
    return 2;
  }

  const privateKey = loadDeviceKey();
  const deviceId = `node-example-${b64(crypto.getRandomValues(new Uint8Array(6))).toLowerCase()}`;

  console.log("== 成功路径 ==");
  const activation = await activate(privateKey, LICENSE_KEY, deviceId);
  console.log("activation_id   :", activation.activation_id);
  console.log("effective_status:", activation.effective_status);
  console.log("expires_at      :", activation.expires_at);
  console.log("entitlements    :", JSON.stringify(activation.entitlements));

  const heartbeat = await call("/activations/heartbeat", {
    activation_id: activation.activation_id,
    refresh_token: activation.refresh_token,
    client: { app_version: "1.5.0", sdk_version: "node-example" },
  });
  console.log(
    "heartbeat       :",
    heartbeat.effective_status,
    `version=${heartbeat.entitlements_version}`,
    `next=${heartbeat.next_heartbeat_seconds}s`,
  );

  console.log("\n== 失败路径 ==");
  try {
    await activate(privateKey, "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", `${deviceId}-bad`);
  } catch (error) {
    if (error instanceof LicenseRejectedError) {
      console.log(`预期失败：${error.message}  (HTTP ${error.status})`);
      console.log("request_id      :", error.requestId);
      return 0;
    }
    throw error;
  }
  console.error("!! 无效授权码居然激活成功，说明校验有问题");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
