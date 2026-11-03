/**
 * 存储适配器统一接口（规格 16.11.9：Local / S3 Compatible / WebDAV / SFTP 为 P0）。
 *
 * 每个适配器都要能回答同一个问题：我能不能连上、能不能写、能不能读回、能不能删。
 * `test()` 必须覆盖「上传 → 下载 → 校验 → 删除」四步，只 ping 一下不算通。
 */
export interface PutResult {
  /** 远端可读 URI，用于在作业里展示与人工核对。 */
  remoteUri: string;
  sizeBytes: number;
}

export interface FetchResult {
  body: Buffer;
  /** 远端声明的校验值（ETag 之类），不可信，只作辅助。 */
  remoteChecksum?: string | null;
}

export interface AdapterContext {
  /** 备份文件在目标上的根前缀（如 licenses/backups/2026-11-02）。 */
  prefix: string;
}

export interface StorageAdapter {
  readonly kind: string;
  /** 分阶段连接测试，返回每一步的结果。任何一步失败都要标注清楚是哪一步。 */
  test(): Promise<Array<{ step: string; ok: boolean; detail?: string }>>;
  put(remotePath: string, body: Buffer): Promise<PutResult>;
  get(remotePath: string): Promise<FetchResult>;
  remove(remotePath: string): Promise<void>;
  /** 能力探测：是否支持版本化、对象锁、原子移动等。用不到就返回空对象。 */
  capabilities(): Promise<Record<string, boolean>>;
}

export class BackupAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
