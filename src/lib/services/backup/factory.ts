import { prisma } from "@/lib/db";
import { openSecret } from "@/lib/auth/secretbox";
import { LocalAdapter } from "./adapters/local";
import { S3Adapter } from "./adapters/s3";
import { WebDavAdapter } from "./adapters/webdav";
import { SftpAdapter } from "./adapters/sftp";
import { BackupAdapterError, type StorageAdapter } from "./types";
import { evaluateInsecureHttpTarget } from "./insecure-http";
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

  // 明文 http 的双重确认（阶段 4）：生产环境下 http + 非回环，必须同时满足
  // `tls_verify=false` 与 `ALLOW_INSECURE_BACKUP_HTTP=true` 才允许建适配器。
  // 放在最前面、对所有 provider 生效，是因为 S3 兼容端点同样可能是 http，
  // 只在 WebDAV 分支里拦会留下一个绕过口子。
  // 执行期（runner）会先判一次并跳过目标；这里再判一次是兜底：
  // 万一有人从重传/恢复演练等别的入口建适配器，也不会把凭据明文发出去。
  const insecureGuard = evaluateInsecureHttpTarget({
    deploymentEnv: config.deploymentEnv,
    endpointUrl: row.endpoint_url,
    tlsVerify: row.tls_verify,
  });
  if (!insecureGuard.allowed) {
    throw new BackupAdapterError("INSECURE_HTTP_NOT_CONFIRMED", insecureGuard.reason ?? "明文 http 备份目标未完成双重确认");
  }

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
        // 适配器这一层只回答「这个地址本身能不能用 http」，收不放宽由上面的 insecureGuard 决定：
        // - 非生产：维持原行为；
        // - 回环地址（localhost / 127.0.0.0/8 / ::1 / 0.0.0.0）：本来就是本机进程内通信，不受限；
        // - 生产 + 非回环：只有 insecureGuard.allowed 为真（双重确认齐了）才会走到这里。
        allowInsecureHttp:
          config.deploymentEnv !== "production" || insecureGuard.loopback || row.tls_verify === false,
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
