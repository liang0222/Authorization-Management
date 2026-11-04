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

/**
 * 控制类请求（MKCOL / DELETE / PROPFIND 级）的超时：30 秒足够。
 */
const CONTROL_TIMEOUT_MS = 30_000;

/**
 * 传输类请求（PUT / GET 整个备份体）的超时。
 *
 * 为什么不能和上面共用 30 秒：备份体是 300 KB 量级，但链路可能只有几百 KB/s，
 * 跨公网的 WebDAV 更容易卡在慢速上行。2026-11-04 03:00 那次定时备份就是
 * `offsite-webdav-remote` 单目标 `UPLOAD_FAILED: The operation was aborted due to timeout`，
 * 另外四个目标全 verified —— 也就是说不是数据问题，是 30 秒这个预算对公网链路太紧。
 * 放宽到 5 分钟；真的断网时 `AbortSignal` 仍会兜住，不会无限挂。
 */
const TRANSFER_TIMEOUT_MS = 300_000;

export class WebDavAdapter implements StorageAdapter {
  readonly kind = "webdav";

  constructor(private readonly options: WebDavOptions) {
    if (!this.options.endpoint.startsWith("https://")) {
      // 明文 http 的放行规则（规格 16.11.4 默认要求 https）：
      // 必须由操作者在目标上显式设 tlsVerify=false，工厂据此传 allowInsecureHttp=true，
      // 等于在配置层面签了「我知道这条链路是明文」。
      // 注意这是真的明文：Basic Auth 的用户名密码和备份字节都会原样过网。
      // 之所以留这条路径，是因为存在只监听 http 的自建对象存储（如 AList 的 /dav），
      // 一刀切拒绝会让「接外部端点」在技术上进不去；是否接受明文由配置方显式承担。
      if (!this.options.allowInsecureHttp) {
        throw new BackupAdapterError(
          "INSECURE_WEBDAV",
          "WebDAV 端点不是 https，且没有显式设 tlsVerify=false 放行",
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
    timeoutMs: number = CONTROL_TIMEOUT_MS,
  ): Promise<Response> {
    const response = await fetch(this.urlFor(remotePath), {
      method,
      headers: { authorization: this.authHeader(), ...extraHeaders },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
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
      const requested = this.urlFor(current);
      const response = await this.request("MKCOL", current);
      // 201 = 新建成功，405 = 已存在（RFC 4918），409 = 部分服务端（如 Apache mod_dav）
      // 对「父目录已存在」也返回 409。三者都表示「目录已经可用」，不该中断连接测试。
      //
      // 301/308：Apache（bytemark/webdav 就是）对「已存在的集合 + 无尾斜杠」会走 mod_dir
      // 的 DirectorySlash，把 MKCOL 也重定向到 `<path>/`。这同样是「目录已存在」的证据。
      // 但 request() 是 redirect:"manual"（跳别的主机等于把备份送给别人），所以这里必须
      // 自己判定：只有同源、且 Location 就是当前路径加一个尾斜杠时才接受，其余一律当失败。
      const slashRedirect =
        (response.status === 301 || response.status === 308) &&
        isSameOriginTrailingSlashRedirect(response.headers.get("location"), requested);
      if (response.status !== 201 && response.status !== 405 && response.status !== 409 && !slashRedirect) {
        throw new BackupAdapterError("WEBDAV_MKCOL_FAILED", `创建目录失败：${current}（HTTP ${response.status}）`);
      }
    }
  }

  async test(): Promise<Array<{ step: string; ok: boolean; detail?: string }>> {
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    // 探针路径相对于 root_path；urlFor() 会补上前缀。自己再拼一遍会叠成 /upload/upload/。
    const probePath = `_probe/${PROBE_FILE}`;
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
    // ensureDirectory 内部经 request() -> urlFor() 已经补了 root_path 前缀，
    // 这里传相对路径即可，再拼一次 prefix 会得到 /upload/upload/... 
    if (parent) await this.ensureDirectory(parent);
    const response = await this.request(
      "PUT",
      remotePath,
      body,
      { "content-type": "application/octet-stream" },
      TRANSFER_TIMEOUT_MS,
    );
    if (response.status >= 300) {
      throw new BackupAdapterError("WEBDAV_PUT_FAILED", `上传失败：HTTP ${response.status}`, response.status >= 500);
    }
    return { remoteUri: this.urlFor(remotePath), sizeBytes: body.byteLength };
  }

  async get(remotePath: string): Promise<FetchResult> {
    const response = await this.request("GET", remotePath, undefined, {}, TRANSFER_TIMEOUT_MS);
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

/**
 * MKCOL 收到 301/308 时判定它是不是「集合已存在」的信号。
 *
 * Apache（bytemark/webdav 就是）对「已存在的集合 + 请求路径无尾斜杠」会走 mod_dir 的
 * DirectorySlash，连 MKCOL 也一起重定向到 `<path>/`。这属于 RFC 4918 之外的实现差异，
 * 但语义上等于「目录已存在」，不该让整个备份失败。
 *
 * 之所以要判得这么细：`request()` 是 `redirect: "manual"`，因为跟随重定向可能把带
 * Basic Auth 的请求送到别的主机。所以我们只接受「同源 + 路径就是自己加一个尾斜杠」，
 * 任何跨主机、跨路径的跳转仍然按失败处理。
 */
export function isSameOriginTrailingSlashRedirect(location: string | null, requested: string): boolean {
  if (!location) return false;
  try {
    const target = new URL(location, requested);
    const origin = new URL(requested);
    if (target.origin !== origin.origin) return false;
    const normalize = (value: string): string => value.replace(/\/+$/, "");
    return normalize(target.pathname) === normalize(origin.pathname);
  } catch {
    return false;
  }
}

