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
 * 把 root_path 与 remote_prefix 拼成最终远端前缀。
 *
 * 这一行以前是漏的：`root_path` 在 WebDAV / SFTP 上被静默丢弃，
 * 用户填了 `/upload` 仍然往账号根目录写，于是「连接测试通过、备份全写错位置」。
 * 现在统一在这里拼，本地/S3 不受影响（它们各自用目录/bucket 表达根）。
 */
function joinRemotePrefix(rootPath: string | null, remotePrefix: string | null): string {
  const root = (rootPath ?? "").replace(/^\/+|\/+$/g, "");
  const prefix = (remotePrefix ?? "").replace(/^\/+|\/+$/g, "");
  const tail = prefix || `backups/${config.deploymentEnv}`;
  return root ? `${root}/${tail}` : tail;
}

export async function createAdapter(row: AdapterRow, organizationId: string): Promise<StorageAdapter> {
  const remotePrefixOnly = (row.remote_prefix ?? "").replace(/^\/+|\/+$/g, "") || `backups/${config.deploymentEnv}`;
  const prefix = joinRemotePrefix(row.root_path, row.remote_prefix);

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
        allowInsecureHttp: config.deploymentEnv !== "production",
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
