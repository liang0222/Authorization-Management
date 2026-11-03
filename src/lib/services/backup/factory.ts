import { prisma } from "@/lib/db";
import { openSecret } from "@/lib/auth/secretbox";
import { LocalAdapter } from "./adapters/local";
import { S3Adapter } from "./adapters/s3";
import { WebDavAdapter } from "./adapters/webdav";
import { SftpAdapter } from "./adapters/sftp";
import { BackupAdapterError, type StorageAdapter } from "./types";
import { config } from "@/lib/config";

/** 数据库行到适配器的映射（只做映射，不做业务判断）。 */
export interface AdapterRow {
  id: string;
  provider_type: string;
  adapter_type: string;
  endpoint_url: string | null;
  region: string | null;
  bucket: string | null;
  root_path: string | null;
  remote_prefix: string | null;
  auth_method: string;
  credential_id: string | null;
  tls_verify: boolean;
}

type CredentialPayload =
  | { kind: "access_key"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: "username_password"; username: string; password: string }
  | { kind: "ssh_key"; username: string; privateKey: string; hostKey?: string; password?: string };

/**
 * 解密存储凭证。
 *
 * 注意编码方向：`createCredential` 落库的是 `sealSecret()` 返回的 **base64 字符串的 UTF-8 字节**，
 * 所以这里必须按 UTF-8 读回那个字符串再交给 `openSecret`。
 * （早先版本这里写成 `toString("base64")`，等于把 base64 文本又编码一次，
 *  GCM 校验必然失败，表现为连接测试报 `Unsupported state or unable to authenticate data`。）
 * 为兼容可能存在的旧行，base64 读法保留为兜底。
 */
export function parseCredential(ciphertext: Uint8Array): CredentialPayload {
  const raw = Buffer.from(ciphertext);
  let plain: string;
  try {
    plain = openSecret(raw.toString("utf8"));
  } catch {
    // 兜底：处理「存的是二进制密文」的历史行。两种都失败就抛原始错误。
    plain = openSecret(raw.toString("base64"));
  }
  const parsed = JSON.parse(plain) as CredentialPayload;
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new BackupAdapterError("CREDENTIAL_INVALID", "凭证格式不正确");
  }
  return parsed;
}

/**
 * 只把 `root_path` 归一成适配器需要的前缀。
 *
 * 职责划分（这里出过一次重复拼接的 bug，写清楚避免再犯）：
 * - `remote_prefix` 由 **runner** 负责：它调用 `adapter.put()` 前已经把 `remote_prefix` 拼进 remotePath；
 * - `root_path` 由 **适配器** 负责：它表达「账号/磁盘根目录下的哪个子目录」，属于连接参数。
 *
 * 以前这里返回 `root_path + remote_prefix`，而 SFTP/WebDAV 适配器又会把 prefix 前置一次，
 * 于是远端路径变成 `/upload/backups/offsite/backups/offsite/bkp_xxx.zmbk`。
 * 本地与 S3 适配器根本不读 `prefix`，所以只有 SFTP/WebDAV 暴露了这个双重拼接。
 */
function joinRemotePrefix(rootPath: string | null): string {
  return (rootPath ?? "").replace(/^\/+|\/+$/g, "");
}

export async function createAdapter(row: AdapterRow, organizationId: string): Promise<StorageAdapter> {
  const remotePrefixOnly = (row.remote_prefix ?? "").replace(/^\/+|\/+$/g, "") || `backups/${config.deploymentEnv}`;
  const prefix = joinRemotePrefix(row.root_path);

  const credential = row.credential_id
    ? await prisma.backup_storage_credentials.findFirst({
        where: { id: row.credential_id, organization_id: organizationId, revoked_at: null },
      })
    : null;

  switch (row.provider_type) {
    case "local":
      return new LocalAdapter(row.root_path || config.backupLocalDir, remotePrefixOnly);

    case "s3": {
      if (!row.endpoint_url || !row.bucket) {
        throw new BackupAdapterError("S3_CONFIG_INCOMPLETE", "S3 目标缺少 endpoint 或 bucket");
      }
      if (!credential) throw new BackupAdapterError("S3_NO_CREDENTIAL", "S3 目标没有可用凭证");
      const cred = parseCredential(credential.ciphertext);
      if (cred.kind !== "access_key") throw new BackupAdapterError("S3_CREDENTIAL_KIND", "S3 需要 access_key 类型凭证");
      return new S3Adapter({
        endpoint: row.endpoint_url,
        region: row.region ?? "us-east-1",
        bucket: row.bucket,
        accessKeyId: cred.accessKeyId,
        secretAccessKey: cred.secretAccessKey,
        sessionToken: cred.sessionToken,
        tlsVerify: row.tls_verify,
        prefix,
      });
    }

    case "webdav": {
      if (!row.endpoint_url) throw new BackupAdapterError("WEBDAV_CONFIG_INCOMPLETE", "WebDAV 目标缺少 endpoint");
      if (!credential) throw new BackupAdapterError("WEBDAV_NO_CREDENTIAL", "WebDAV 目标没有可用凭证");
      const cred = parseCredential(credential.ciphertext);
      if (cred.kind !== "username_password") {
        throw new BackupAdapterError("WEBDAV_CREDENTIAL_KIND", "WebDAV 需要 username_password 类型凭证");
      }
      return new WebDavAdapter({
        endpoint: row.endpoint_url,
        username: cred.username,
        password: cred.password,
        prefix,
        // 生产默认只允许 https；操作者显式把 tlsVerify 设为 false（＝我确认这是内网/本机端点）
        // 时才放行 http。放行后 WebDavAdapter 自己还会再检查一次：
        // 非 https 且主机不是 localhost/127.0.0.1/::1 一律拒绝，所以公网 http 依然进不来。
        // 两层的分工是：这里决定「生产要不要收紧」，适配器决定「这个地址本身能不能用 http」。
        allowInsecureHttp: config.deploymentEnv !== "production" || row.tls_verify === false,
      });
    }

    case "sftp": {
      if (!row.endpoint_url) throw new BackupAdapterError("SFTP_CONFIG_INCOMPLETE", "SFTP 目标缺少主机地址");
      if (!credential) throw new BackupAdapterError("SFTP_NO_CREDENTIAL", "SFTP 目标没有可用凭证");
      const cred = parseCredential(credential.ciphertext);
      if (cred.kind !== "ssh_key") throw new BackupAdapterError("SFTP_CREDENTIAL_KIND", "SFTP 需要 ssh_key 类型凭证");
      const url = new URL(row.endpoint_url.includes("://") ? row.endpoint_url : `sftp://${row.endpoint_url}`);
      return new SftpAdapter({
        host: url.hostname,
        port: Number(url.port || 22),
        username: cred.username,
        privateKey: cred.privateKey,
        password: cred.password,
        hostKey: cred.hostKey ?? "",
        prefix,
      });
    }

    default:
      // 规格 16.11.1：未实测的连接器不得标为「已支持」，这里直接明确拒绝。
      throw new BackupAdapterError(
        "PROVIDER_NOT_SUPPORTED",
        `${row.provider_type} 尚未实现（P0 仅支持 local / s3 / webdav / sftp）`,
      );
  }
}
