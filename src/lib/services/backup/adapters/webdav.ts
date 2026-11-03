import { BackupAdapterError, type FetchResult, type PutResult, type StorageAdapter } from "../types";

/**
 * WebDAV 适配器（规格 16.11.4）。
 *
 * 强制约束都写在这里，因为这是最容易「为了跑通」而被放松的地方：
 * - 生产只允许 https（http 只对本机开发地址放行）；
 * - 连接测试必须真的上传再下载比对，不能只看 PROPFIND 有没有 200；
 * - 不假设服务端支持原子 MOVE，也不把 ETag 当作 SHA-256。
 */
export interface WebDavOptions {
  endpoint: string;
  username: string;
  password: string;
  /** 远端根前缀，已由调用方拼好。 */
  prefix: string;
  allowInsecureHttp?: boolean;
}

const PROBE_FILE = "ziming-connectivity-probe.txt";

export class WebDavAdapter implements StorageAdapter {
  readonly kind = "webdav";

  constructor(private readonly options: WebDavOptions) {
    if (!this.options.endpoint.startsWith("https://")) {
      const host = safeHost(this.options.endpoint);
      const localOnly = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!localOnly || !this.options.allowInsecureHttp) {
        throw new BackupAdapterError(
          "INSECURE_WEBDAV",
          "WebDAV 端点必须是 https（仅本机开发地址可显式放行 http）",
        );
      }
    }
  }

  private authHeader(): string {
    const raw = `${this.options.username}:${this.options.password}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  private urlFor(remotePath: string): string {
    const base = this.options.endpoint.replace(/\/$/, "");
    const prefix = this.options.prefix.replace(/^\/|\/$/g, "");
    const path = remotePath.replace(/^\/+/, "");
    const segments = [prefix, path].filter(Boolean).flatMap((item) => item.split("/"));
    return `${base}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  }

  private async request(
    method: string,
    remotePath: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const response = await fetch(this.urlFor(remotePath), {
      method,
      headers: { authorization: this.authHeader(), ...extraHeaders },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      // 不跟随重定向：跳到别的主机等于把备份送给了别人。
      redirect: "manual",
    });
    if (response.status >= 400 && response.status !== 404 && response.status !== 405) {
      throw new BackupAdapterError(
        `WEBDAV_${method}_${response.status}`,
        `WebDAV ${method} 失败：HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    return response;
  }

  /** 逐级 MKCOL，已存在（405）视为正常。 */
  private async ensureDirectory(remotePath: string): Promise<void> {
    const segments = remotePath.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const response = await this.request("MKCOL", current);
      // 201 = 新建成功，405 = 已存在（RFC 4918），409 = 部分服务端（如 Apache mod_dav）
      // 对「父目录已存在」也返回 409。三者都表示「目录已经可用」，不该中断连接测试。
      if (response.status !== 201 && response.status !== 405 && response.status !== 409) {
        throw new BackupAdapterError("WEBDAV_MKCOL_FAILED", `创建目录失败：${current}（HTTP ${response.status}）`);
      }
    }
  }

  async test(): Promise<Array<{ step: string; ok: boolean; detail?: string }>> {
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    const probePath = `${this.options.prefix.replace(/^\/|\/$/g, "")}/_probe/${PROBE_FILE}`;
    const payload = Buffer.from(`ziming probe ${new Date().toISOString()}`, "utf8");

    try {
      await this.ensureDirectory(probePath.split("/").slice(0, -1).join("/"));
      steps.push({ step: "认证", ok: true, detail: "Basic Auth 通过" });

      const put = await this.request("PUT", probePath, payload, { "content-type": "text/plain" });
      steps.push({ step: "上传", ok: put.status < 300, detail: `HTTP ${put.status}` });
      if (put.status >= 300) return steps;

      const got = await this.request("GET", probePath);
      const body = Buffer.from(await got.arrayBuffer());
      const matched = body.equals(payload);
      steps.push({
        step: "下载比对",
        ok: matched,
        detail: matched ? `SHA-256 一致（${body.byteLength} 字节）` : "内容不一致",
      });

      const del = await this.request("DELETE", probePath);
      steps.push({ step: "删除测试文件", ok: del.status < 300 || del.status === 404, detail: `HTTP ${del.status}` });
    } catch (error) {
      steps.push({ step: "连接失败", ok: false, detail: (error as Error).message });
    }
    return steps;
  }

  async put(remotePath: string, body: Buffer): Promise<PutResult> {
    const parent = remotePath.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDirectory(`${this.options.prefix.replace(/^\/|\/$/g, "")}/${parent}`);
    const response = await this.request("PUT", remotePath, body, { "content-type": "application/octet-stream" });
    if (response.status >= 300) {
      throw new BackupAdapterError("WEBDAV_PUT_FAILED", `上传失败：HTTP ${response.status}`, response.status >= 500);
    }
    return { remoteUri: this.urlFor(remotePath), sizeBytes: body.byteLength };
  }

  async get(remotePath: string): Promise<FetchResult> {
    const response = await this.request("GET", remotePath);
    if (response.status === 404) {
      throw new BackupAdapterError("WEBDAV_NOT_FOUND", "远端文件不存在");
    }
    return {
      body: Buffer.from(await response.arrayBuffer()),
      // ETag 只是辅助信息，绝不能当 SHA-256 用。
      remoteChecksum: response.headers.get("etag"),
    };
  }

  async remove(remotePath: string): Promise<void> {
    await this.request("DELETE", remotePath);
  }

  async capabilities(): Promise<Record<string, boolean>> {
    // 未实测的一律不标 true（规格 16.11.1：不得把未测连接器标为「已支持」）。
    return { versioning: false, object_lock: false, atomic_move: false, checksum_native: false };
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
