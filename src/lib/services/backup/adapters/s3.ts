import { createHash, createHmac } from "node:crypto";
import type { FetchResult, PutResult, StorageAdapter } from "../types";
import { BackupAdapterError } from "../types";

/**
 * S3 / S3 兼容存储（规格 16.11.1 P0）。
 *
 * 手写 SigV4 而不是引 SDK：这里只需要 PUT / GET / DELETE / HEAD 四个动作，
 * 引一个几 MB 的 SDK 反而增加供应链面。签名逻辑集中在一处，单元测试直接比对官方向量。
 */
export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 兼容 MinIO / 阿里云 OSS 等：路径风格而非虚拟主机风格。 */
  forcePathStyle?: boolean;
  sessionToken?: string;
  tlsVerify?: boolean;
  /** 远端根前缀，由工厂统一拼好传入。 */
  prefix?: string;
}

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function encodeKeyPath(key: string): string {
  // S3 的 URI 编码规则：保留 `/`，其余按 RFC 3986 且不编码 `!'()*` 之外的子集。
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export interface CanonicalInput {
  method: string;
  accessKeyId: string;
  bucket: string;
  key: string;
  query?: Record<string, string>;
  payloadHash: string;
  headers: Record<string, string>;
  amzDate: string;
  region: string;
}

/** 生成 SigV4 的 Authorization 头。抽成纯函数，方便用官方向量做单测。 */
export function buildAuthorization(
  input: CanonicalInput,
  secretAccessKey: string,
): string {
  const canonicalUri = `/${input.bucket}/${encodeKeyPath(input.key)}`;
  const queryKeys = Object.keys(input.query ?? {}).sort();
  const canonicalQuery = queryKeys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent((input.query ?? {})[key])}`)
    .join("&");

  const sortedHeaders = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaders
    .map((name) => `${name}:${String(input.headers[name] ?? input.headers[name.toLowerCase()]).trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaders.join(";");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  let signingKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  signingKey = hmac(signingKey, input.region);
  signingKey = hmac(signingKey, SERVICE);
  signingKey = hmac(signingKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function amzNow(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export class S3Adapter implements StorageAdapter {
  readonly kind = "s3";

  constructor(private readonly options: S3Options) {}

  private url(key: string): string {
    const endpoint = this.options.endpoint.replace(/\/$/, "");
    const encoded = encodeKeyPath(key);
    if (this.options.forcePathStyle === false) {
      return `${endpoint.replace("://", `://${this.options.bucket}.`)}/${encoded}`;
    }
    return `${endpoint}/${this.options.bucket}/${encoded}`;
  }

  private signedHeaders(
    method: string,
    key: string,
    payloadHash: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const amzDate = amzNow();
    const headers: Record<string, string> = {
      host: new URL(this.url(key)).host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extra,
    };
    if (this.options.sessionToken) headers["x-amz-security-token"] = this.options.sessionToken;

    const authorization = buildAuthorization(
      {
        method,
        accessKeyId: this.options.accessKeyId,
        bucket: this.options.bucket,
        key,
        payloadHash,
        headers,
        amzDate,
        region: this.options.region,
      },
      this.options.secretAccessKey,
    );

    return { ...headers, authorization };
  }

  private async request(
    method: string,
    key: string,
    body?: Buffer,
  ): Promise<Response> {
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const headers = this.signedHeaders(method, key, payloadHash);
    if (body) headers["content-length"] = String(body.length);

    const response = await fetch(this.url(key), {
      method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    return response;
  }

  async test() {
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    try {
      const probeKey = `.probe/${Date.now()}.txt`;
      const payload = Buffer.from("ok");
      const put = await this.request("PUT", probeKey, payload);
      steps.push({ step: "上传测试对象", ok: put.ok, detail: put.ok ? undefined : `HTTP ${put.status}` });
      if (!put.ok) return steps;

      const get = await this.request("GET", probeKey);
      const text = get.ok ? await get.text() : "";
      steps.push({ step: "下载并比对", ok: text === "ok", detail: text === "ok" ? undefined : `HTTP ${get.status}` });

      const del = await this.request("DELETE", probeKey);
      steps.push({ step: "删除测试对象", ok: del.ok || del.status === 204, detail: del.ok ? undefined : `HTTP ${del.status}` });
    } catch (error) {
      steps.push({ step: "连接失败", ok: false, detail: (error as Error).message });
    }
    return steps;
  }

  async put(remotePath: string, body: Buffer): Promise<PutResult> {
    const response = await this.request("PUT", remotePath, body);
    if (!response.ok) {
      throw new BackupAdapterError(`S3_PUT_${response.status}`, `S3 上传失败：HTTP ${response.status}`, response.status >= 500);
    }
    return { remoteUri: `s3://${this.options.bucket}/${remotePath}`, sizeBytes: body.length };
  }

  async get(remotePath: string): Promise<FetchResult> {
    const response = await this.request("GET", remotePath);
    if (!response.ok) {
      throw new BackupAdapterError(`S3_GET_${response.status}`, `S3 下载失败：HTTP ${response.status}`, response.status >= 500);
    }
    const body = Buffer.from(await response.arrayBuffer());
    return { body, remoteChecksum: response.headers.get("etag") };
  }

  async remove(remotePath: string): Promise<void> {
    const response = await this.request("DELETE", remotePath);
    if (!response.ok && response.status !== 204) {
      throw new BackupAdapterError(`S3_DELETE_${response.status}`, `S3 删除失败：HTTP ${response.status}`);
    }
  }

  async capabilities() {
    // 真实实现应当发 HEAD /?x-id=GetBucketVersioning 探测；这里返回保守值，
    // 不谎称支持版本化或对象锁（规格 16.11.1 要求「不得把未测能力标为已支持」）。
    return { versioning: false, object_lock: false, atomic_move: false, checksum_native: false };
  }
}
