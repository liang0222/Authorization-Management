import { z } from "zod";

import { BackupPathError, assertSafeBackupPath } from "./paths";

/**
 * 备份目标/策略的入参校验。
 *
 * 校验分两层：
 * 1) zod 管「形状」（类型、长度、枚举）；
 * 2) requireFieldsForProvider 管「组合」（S3 必须有 endpoint + bucket + access_key 凭证……）。
 * 分开写是因为 zod 的 refine 报错位置很难看，而组合错误需要精确告诉用户缺哪一项。
 */

export const credentialSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("access_key"),
    accessKeyId: z.string().min(3).max(200),
    secretAccessKey: z.string().min(8).max(400),
    sessionToken: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal("username_password"),
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(400),
  }),
  z.object({
    kind: z.literal("ssh_key"),
    username: z.string().min(1).max(200),
    privateKey: z.string().min(20).max(8000),
    hostKey: z.string().max(400).optional(),
    password: z.string().max(400).optional(),
  }),
]);

export type CredentialPayload = z.infer<typeof credentialSchema>;

export const P0_PROVIDERS = ["local", "s3", "webdav", "sftp"] as const;
export type P0Provider = (typeof P0_PROVIDERS)[number];

/** 路径字段：长度之外还要拒绝 `..`、反斜杠、编码后的分隔符（见 paths.ts）。 */
function safePathField(label: string, max: number) {
  return z.string().max(max).superRefine((value, ctx) => {
    if (!value.trim()) return;
    try {
      assertSafeBackupPath(value, label);
    } catch (error) {
      const message = error instanceof BackupPathError ? error.message : `${label}不合法`;
      ctx.addIssue({ code: "custom", message });
    }
  });
}

/** 相对前缀：拒绝穿越，并把首尾 `/` 归一化掉（绝对写法落回目标根内，而不是被当成新根）。 */
function relativePrefixField(label: string, max: number) {
  return safePathField(label, max).transform((value) => value.trim().replace(/^\/+|\/+$/g, ""));
}

export const destinationCreateSchema = z.object({
  name: z.string().min(1).max(120),
  providerType: z.enum(P0_PROVIDERS),
  adapterType: z.enum(["native", "rclone", "mounted_filesystem"]).optional(),
  endpointUrl: z.string().max(500).nullish(),
  region: z.string().max(64).nullish(),
  bucket: z.string().max(160).nullish(),
  rootPath: safePathField("root_path", 500).nullish(),
  remotePrefix: relativePrefixField("remote_prefix", 300).nullish(),
  authMethod: z.enum(["access_key", "username_password", "ssh_key", "none"]),
  tlsVerify: z.boolean().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(9999).optional(),
  isRequired: z.boolean().optional(),
  credential: credentialSchema.optional(),
});

export const destinationPatchSchema = destinationCreateSchema.partial().extend({
  // PATCH 允许只换凭证，不动其它字段。
  credential: credentialSchema.optional(),
});

/** 按 provider 校验必填项，返回人类可读的错误信息（null 表示通过）。 */
export function requireFieldsForProvider(input: {
  providerType: string;
  endpointUrl?: string | null;
  bucket?: string | null;
  authMethod?: string;
  hasCredential: boolean;
  credentialKind?: string | null;
}): string | null {
  switch (input.providerType) {
    case "local":
      // root_path 留空时用服务端默认目录（config.backupLocalDir），这是刻意允许的。
      return null;
    case "s3":
      if (!input.endpointUrl) return "S3 兼容存储必须填 Endpoint（例如 https://s3.us-east-1.amazonaws.com）";
      if (!input.bucket) return "S3 兼容存储必须填 Bucket";
      if (!input.hasCredential) return "S3 兼容存储必须配置 Access Key 凭证";
      if (input.credentialKind && input.credentialKind !== "access_key") return "S3 目标的凭证类型必须是 access_key";
      return null;
    case "webdav":
      if (!input.endpointUrl) return "WebDAV 必须填 Endpoint（生产只允许 https）";
      if (!input.hasCredential) return "WebDAV 必须配置用户名密码凭证";
      if (input.credentialKind && input.credentialKind !== "username_password") return "WebDAV 目标的凭证类型必须是 username_password";
      return null;
    case "sftp":
      if (!input.endpointUrl) return "SFTP 必须填主机地址（host 或 sftp://host:port）";
      if (!input.hasCredential) return "SFTP 必须配置 SSH 私钥凭证";
      if (input.credentialKind && input.credentialKind !== "ssh_key") return "SFTP 目标的凭证类型必须是 ssh_key";
      return null;
    default:
      return `不支持的存储类型：${input.providerType}`;
  }
}

export const retentionSchema = z.object({
  daily: z.number().int().min(1).max(365),
  weekly: z.number().int().min(0).max(104),
  monthly: z.number().int().min(0).max(120),
});

export const policyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  scheduleCron: z.string().min(5).max(60).optional(),
  timezone: z.string().min(1).max(64).optional(),
  targetMode: z.enum(["all_required", "primary_then_fallback", "quorum"]).optional(),
  requiredSuccessCount: z.number().int().min(1).max(32).nullish(),
  retention: retentionSchema.optional(),
  verifyMode: z.enum(["sha256", "sha256_and_manifest"]).optional(),
  bandwidthLimitKbps: z.number().int().min(64).max(10_000_000).nullish(),
  parallelism: z.number().int().min(1).max(16).optional(),
  encrypt: z.boolean().optional(),
  enabled: z.boolean().optional(),
  targets: z
    .array(
      z.object({
        destinationId: z.string().uuid(),
        priority: z.number().int().min(1).max(9999).optional(),
        isRequired: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(16),
});

export const policyPatchSchema = policyCreateSchema.partial().extend({
  targets: policyCreateSchema.shape.targets.optional(),
});

/** 极简 cron 校验：只接受 5 段与常见字段，拒绝明显写错的调度。 */
export function isCronLike(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^[0-9*/,?#LW-]+$/i.test(part));
}
