import { describeCron, nextRunAfter } from "@/lib/domain/cron";
import type {
  backup_job_targets,
  backup_jobs,
  backup_policies,
  backup_restore_tests,
} from "@/generated/prisma/client";

/**
 * 备份模块的对外 DTO。
 *
 * 一条铁律：**凭证永远不出后端**。接口只回 `credentialConfigured` 布尔值与掩码，
 * 连密文都不下发 —— 前端拿到密文也没有意义，只会扩大泄露面（规格 16.11.2）。
 *
 * 这里的入参用结构类型而不是 Prisma 的模型类型：查询里用 `select`/`include` 取子集时，
 * 模型类型会要求那些没查的字段，结构类型只要求真正用到的字段。
 */

export interface DestinationFields {
  id: string;
  name: string;
  provider_type: string;
  adapter_type: string;
  endpoint_url: string | null;
  region: string | null;
  bucket: string | null;
  root_path: string | null;
  remote_prefix: string | null;
  auth_method: string;
  tls_verify: boolean;
  enabled: boolean;
  priority: number;
  is_required: boolean;
  capability_snapshot: unknown;
  last_tested_at: Date | null;
  last_test_status: string;
  last_test_error_code: string | null;
  last_test_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function destinationDto(row: DestinationFields, credentialConfigured: boolean) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    adapterType: row.adapter_type,
    endpointUrl: row.endpoint_url,
    region: row.region,
    bucket: row.bucket,
    rootPath: row.root_path,
    remotePrefix: row.remote_prefix,
    authMethod: row.auth_method,
    credentialConfigured,
    tlsVerify: row.tls_verify,
    enabled: row.enabled,
    priority: row.priority,
    isRequired: row.is_required,
    capabilitySnapshot: row.capability_snapshot,
    lastTestedAt: row.last_tested_at,
    lastTestStatus: row.last_test_status,
    lastTestErrorCode: row.last_test_error_code,
    lastTestError: row.last_test_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type DestinationRowWithCredential = DestinationFields & {
  /** 未吊销的凭证（`take: 1` 让 Prisma 返回数组）。 */
  backup_storage_credentials_backup_storage_credentials_destination_idTobackup_storage_destinations: Array<{ id: string }>;
};

export function destinationRowDto(row: DestinationRowWithCredential) {
  return destinationDto(
    row,
    row.backup_storage_credentials_backup_storage_credentials_destination_idTobackup_storage_destinations.length > 0,
  );
}

export function policyDto(row: backup_policies & { backup_policy_targets: Array<{ destination_id: string; priority: number; is_required: boolean; backup_storage_destinations: { name: string; provider_type: string } }> }) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    targetMode: row.target_mode,
    requiredSuccessCount: row.required_success_count,
    retention: row.retention_json,
    verifyMode: row.verify_mode,
    bandwidthLimitKbps: row.bandwidth_limit_kbps,
    parallelism: row.parallelism,
    encrypt: row.encrypt,
    enabled: row.enabled,
    /** 人话描述 + 下次执行时刻：让「到点自动执行」这件事在界面上可验证，而不是只写在文案里。 */
    scheduleText: describeCron(row.schedule_cron, row.timezone),
    nextRunAt: row.enabled ? nextRunAfter(row.schedule_cron, new Date(), row.timezone) : null,
    targets: row.backup_policy_targets
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((item) => ({
        destinationId: item.destination_id,
        name: item.backup_storage_destinations.name,
        providerType: item.backup_storage_destinations.provider_type,
        priority: item.priority,
        isRequired: item.is_required,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function jobTargetDto(row: backup_job_targets & { backup_storage_destinations: { name: string; provider_type: string } }) {
  return {
    id: row.id,
    destinationId: row.destination_id,
    destinationName: row.backup_storage_destinations.name,
    providerType: row.backup_storage_destinations.provider_type,
    status: row.status,
    remoteUri: row.remote_uri,
    remoteSizeBytes: row.remote_size_bytes === null ? null : Number(row.remote_size_bytes),
    checksumSha256: row.checksum_sha256,
    uploadedAt: row.uploaded_at,
    verifiedAt: row.verified_at,
    retryCount: row.retry_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export function jobDto(
  row: backup_jobs & {
    backup_job_targets: Array<backup_job_targets & { backup_storage_destinations: { name: string; provider_type: string } }>;
    backup_policies: { name: string } | null;
    users: { display_name: string; email: string } | null;
  },
) {
  return {
    id: row.id,
    backupId: row.backup_id,
    policyId: row.policy_id,
    policyName: row.backup_policies?.name ?? null,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.started_at && row.finished_at ? new Date(row.finished_at).getTime() - new Date(row.started_at).getTime() : null,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    manifestSha256: row.manifest_sha256,
    hasLocalStaging: Boolean(row.local_path),
    /** 保留策略清掉该备份文件的时间；非空表示文件已删、作业记录仍在（审计凭据）。 */
    purgedAt: row.purged_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdBy: row.users?.display_name ?? null,
    createdAt: row.created_at,
    targets: row.backup_job_targets.map(jobTargetDto),
  };
}

export function restoreTestDto(row: backup_restore_tests & { backup_jobs: { backup_id: string } | null }) {
  return {
    id: row.id,
    jobId: row.job_id,
    backupId: row.backup_jobs?.backup_id ?? null,
    status: row.status,
    testEnvironment: row.test_environment,
    checks: row.verified_checks_json,
    rpoSeconds: row.rpo_seconds,
    rtoSeconds: row.rto_seconds,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}
