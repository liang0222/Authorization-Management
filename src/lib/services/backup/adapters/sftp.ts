import { Client, type ConnectConfig } from "ssh2";
import { assertSafeBackupPath, normalizeRelativePrefix } from "../paths";
import { BackupAdapterError, type FetchResult, type PutResult, type StorageAdapter } from "../types";

/**
 * SFTP 适配器（规格 16.11.5）。
 *
 * 两个刻意的限制：
 * - 主机指纹必须固定传入：`known_hosts` 校验做不到位时宁可不连，也不要「先信任再说」。
 * - 默认 shell_type = none，本适配器只用 SFTP 子系统，不执行任何远端 shell 命令。
 * - SFTP 没有原生 SHA-256，校验以本地计算的 manifest 为准（远端 size 只作参考）。
 */
export interface SftpOptions {
  host: string;
  port: number;
  username: string;
  /** 私钥 PEM；密码认证仅在私钥不可用时使用。 */
  privateKey?: string;
  password?: string;
  /** `ssh-ed25519 AAAA...` 形式的已知主机公钥，必填。 */
  hostKey: string;
  prefix: string;
}

export class SftpAdapter implements StorageAdapter {
  readonly kind = "sftp";
  private readonly prefix: string;

  constructor(private readonly options: SftpOptions) {
    this.prefix = normalizeRelativePrefix(options.prefix, "SFTP 根路径");
  }

  private connect(): Promise<Client> {
    if (!this.options.hostKey) {
      return Promise.reject(
        new BackupAdapterError("SFTP_HOST_KEY_REQUIRED", "必须提供主机指纹（host key），否则无法保证连的是预期主机"),
      );
    }
    const connectConfig: ConnectConfig = {
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      // 只接受与配置完全一致的主机公钥：指纹变了要失败告警，而不是静默继续。
      hostVerifier: (key: Buffer) => key.toString("base64") === this.normalizeHostKey(),
      readyTimeout: 15_000,
    };
    if (this.options.privateKey) {
      connectConfig.privateKey = this.options.privateKey;
    } else if (this.options.password) {
      connectConfig.password = this.options.password;
    } else {
      return Promise.reject(new BackupAdapterError("SFTP_NO_CREDENTIAL", "缺少私钥或密码"));
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      client.once("ready", () => resolve(client));
      client.once("error", (error) => reject(
        new BackupAdapterError("SFTP_CONNECT_FAILED", `SFTP 连接失败：${error.message}`, true),
      ));
      client.connect(connectConfig);
    });
  }

  private normalizeHostKey(): string {
    const parts = this.options.hostKey.trim().split(/\s+/);
    return parts.length >= 2 ? parts[1] : this.options.hostKey.trim();
  }

  private remotePath(remotePath: string): string {
    // 绝对路径由这里统一补根前缀；`..` 段必须拒绝，否则 SFTP 的路径解析会逃出根目录。
    const relative = assertSafeBackupPath(remotePath, "SFTP 相对路径").replace(/^\/+/, "");
    return `/${[this.prefix, relative].filter(Boolean).join("/")}`;
  }

  async test(): Promise<Array<{ step: string; ok: boolean; detail?: string }>> {
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    let client: Client | null = null;
    // 探针路径必须是「相对于 root_path」的，remotePath() 负责补上 root_path 前缀。
    // 以前这里自己又拼了一次 prefix，于是探针实际落在 /upload/upload/_probe/ 下，
    // 测试通过但位置是错的。
    const probePath = "_probe/connectivity.txt";
    const payload = Buffer.from(`ziming probe ${new Date().toISOString()}`, "utf8");

    try {
      client = await this.connect();
      steps.push({ step: "连接与主机指纹", ok: true, detail: `${this.options.host}:${this.options.port}` });

      await this.withSftp(client, (sftp) => this.mkdirp(sftp, this.remotePath(probePath).split("/").slice(0, -1).join("/")));
      steps.push({ step: "创建目录", ok: true });

      await this.withSftp(client, (sftp) => this.writeFile(sftp, this.remotePath(probePath), payload));
      steps.push({ step: "上传", ok: true, detail: `${payload.byteLength} 字节` });

      const readBack = await this.withSftp(client, (sftp) => this.readFile(sftp, this.remotePath(probePath)));
      steps.push({ step: "下载比对", ok: readBack.equals(payload), detail: readBack.equals(payload) ? "内容一致" : "内容不一致" });

      await this.withSftp(client, (sftp) => this.unlink(sftp, this.remotePath(probePath)));
      steps.push({ step: "删除测试文件", ok: true });
    } catch (error) {
      steps.push({ step: "连接失败", ok: false, detail: (error as Error).message });
    } finally {
      client?.end();
    }
    return steps;
  }

  async put(remotePath: string, body: Buffer): Promise<PutResult> {
    const client = await this.connect();
    try {
      const target = this.remotePath(remotePath);
      await this.withSftp(client, (sftp) => this.mkdirp(sftp, target.split("/").slice(0, -1).join("/")));
      await this.withSftp(client, (sftp) => this.writeFile(sftp, target, body));
      return { remoteUri: `sftp://${this.options.host}:${this.options.port}${target}`, sizeBytes: body.byteLength };
    } finally {
      client.end();
    }
  }

  async get(remotePath: string): Promise<FetchResult> {
    const client = await this.connect();
    try {
      const target = this.remotePath(remotePath);
      const body = await this.withSftp(client, (sftp) => this.readFile(sftp, target));
      return { body, remoteChecksum: null };
    } finally {
      client.end();
    }
  }

  async remove(remotePath: string): Promise<void> {
    const client = await this.connect();
    try {
      await this.withSftp(client, (sftp) => this.unlink(sftp, this.remotePath(remotePath)));
    } finally {
      client.end();
    }
  }

  async capabilities(): Promise<Record<string, boolean>> {
    return { versioning: false, object_lock: false, atomic_move: true, checksum_native: false };
  }

  private withSftp<T>(client: Client, action: (sftp: SftpLike) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(new BackupAdapterError("SFTP_SUBSYSTEM_FAILED", `无法打开 SFTP 子系统：${error.message}`));
          return;
        }
        action(sftp as unknown as SftpLike).then(resolve, reject);
      });
    });
  }

  private mkdirp(sftp: SftpLike, dir: string): Promise<void> {
    const segments = dir.split("/").filter(Boolean);
    let current = "";
    return segments.reduce<Promise<void>>((chain, segment) => chain.then(() => {
      current += `/${segment}`;
      return new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (error) => {
          // 已存在（4 = SSH_FX_FAILURE 常见于目录已存在）不算错误。
          if (!error) return resolve();
          sftp.stat(current, (statError) => (statError ? reject(error) : resolve()));
        });
      });
    }), Promise.resolve());
  }

  private writeFile(sftp: SftpLike, path: string, body: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.writeFile(path, body, (error) => (error ? reject(error) : resolve()));
    });
  }

  private readFile(sftp: SftpLike, path: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      sftp.readFile(path, (error, data) => (error ? reject(error) : resolve(Buffer.from(data))));
    });
  }

  private unlink(sftp: SftpLike, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.unlink(path, (error) => (error ? reject(error) : resolve()));
    });
  }
}

interface SftpLike {
  mkdir(path: string, callback: (error: Error | null | undefined) => void): void;
  stat(path: string, callback: (error: Error | null | undefined) => void): void;
  writeFile(path: string, data: Buffer, callback: (error: Error | null | undefined) => void): void;
  readFile(path: string, callback: (error: Error | null | undefined, data: Buffer) => void): void;
  unlink(path: string, callback: (error: Error | null | undefined) => void): void;
}
