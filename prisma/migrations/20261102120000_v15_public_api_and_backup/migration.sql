-- v1.5 增量迁移：公开 API 限流、可信服务端断言防重放、权益版本号、多协议备份与灾备。
-- 原则：只做向前兼容的新增（加表、加列、加索引），不删列、不改既有列语义。

-- ---------------------------------------------------------------------------
-- 1. 公开 API 分层限流（规格 27.6：按产品/凭证/IP/端点分层，不能只按 IP）
--    放在数据库而不是进程内 Map，多实例部署才有效。
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limit_buckets (
  bucket_key varchar(240) PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX idx_rate_limit_buckets_expires ON rate_limit_buckets (expires_at);

-- ---------------------------------------------------------------------------
-- 2. 可信服务端主体断言的一次性 jti（规格 4.12：subject assertion 必须防重放）
-- ---------------------------------------------------------------------------
CREATE TABLE server_assertion_jtis (
  jti varchar(120) PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL,
  credential_id uuid,
  subject varchar(200),
  seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id)
);

CREATE INDEX idx_server_assertion_jtis_expires ON server_assertion_jtis (expires_at);

-- ---------------------------------------------------------------------------
-- 3. 权益版本号（规格 4.8 / 4.10：响应必须带 entitlements_version）
-- ---------------------------------------------------------------------------
ALTER TABLE licenses
  ADD COLUMN entitlements_version integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 4. 多协议备份与灾备（规格 16.10–16.12）
-- ---------------------------------------------------------------------------
CREATE TYPE backup_provider_type AS ENUM (
  'local', 's3', 'webdav', 'sftp', 'ftps', 'smb',
  'google_drive', 'onedrive', 'dropbox', 'rclone_other'
);
CREATE TYPE backup_adapter_type AS ENUM ('native', 'rclone', 'mounted_filesystem');
CREATE TYPE backup_auth_method AS ENUM ('access_key', 'username_password', 'ssh_key', 'oauth2', 'none');
CREATE TYPE backup_test_status AS ENUM ('untested', 'passed', 'failed');
CREATE TYPE backup_job_status AS ENUM ('queued', 'running', 'partial', 'degraded', 'succeeded', 'failed');
CREATE TYPE backup_target_status AS ENUM ('queued', 'uploading', 'uploaded', 'verifying', 'verified', 'failed', 'skipped');
CREATE TYPE backup_target_mode AS ENUM ('all_required', 'primary_then_fallback', 'quorum');
CREATE TYPE backup_verify_mode AS ENUM ('sha256', 'sha256_and_manifest');
CREATE TYPE backup_restore_status AS ENUM ('queued', 'running', 'passed', 'failed');

CREATE TABLE backup_storage_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(120) NOT NULL,
  provider_type backup_provider_type NOT NULL,
  adapter_type backup_adapter_type NOT NULL DEFAULT 'native',
  endpoint_url text,
  region varchar(64),
  bucket varchar(160),
  root_path text,
  remote_prefix text,
  auth_method backup_auth_method NOT NULL DEFAULT 'none',
  credential_id uuid,
  tls_verify boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  is_required boolean NOT NULL DEFAULT true,
  capability_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  last_test_status backup_test_status NOT NULL DEFAULT 'untested',
  last_test_error_code varchar(80),
  last_test_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE backup_storage_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  destination_id uuid NOT NULL REFERENCES backup_storage_destinations(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  algorithm varchar(40) NOT NULL DEFAULT 'aes-256-gcm',
  key_version integer NOT NULL DEFAULT 1,
  fingerprint varchar(120),
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE backup_storage_destinations
  ADD CONSTRAINT backup_storage_destinations_credential_fk
  FOREIGN KEY (credential_id) REFERENCES backup_storage_credentials(id) ON DELETE SET NULL;

CREATE TABLE backup_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(120) NOT NULL,
  scope varchar(40) NOT NULL DEFAULT 'database',
  schedule_cron varchar(60) NOT NULL DEFAULT '0 3 * * *',
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  target_mode backup_target_mode NOT NULL DEFAULT 'all_required',
  required_success_count integer,
  retention_json jsonb NOT NULL DEFAULT '{"daily": 7, "weekly": 4, "monthly": 6}'::jsonb,
  verify_mode backup_verify_mode NOT NULL DEFAULT 'sha256_and_manifest',
  bandwidth_limit_kbps integer CHECK (bandwidth_limit_kbps IS NULL OR bandwidth_limit_kbps > 0),
  parallelism integer NOT NULL DEFAULT 2 CHECK (parallelism >= 1),
  encrypt boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE backup_policy_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  policy_id uuid NOT NULL REFERENCES backup_policies(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES backup_storage_destinations(id) ON DELETE RESTRICT,
  priority integer NOT NULL DEFAULT 100,
  is_required boolean NOT NULL DEFAULT true,
  UNIQUE (policy_id, destination_id)
);

CREATE TABLE backup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  policy_id uuid REFERENCES backup_policies(id) ON DELETE SET NULL,
  backup_id varchar(80) NOT NULL UNIQUE,
  status backup_job_status NOT NULL DEFAULT 'queued',
  trigger varchar(40) NOT NULL DEFAULT 'manual',
  started_at timestamptz,
  finished_at timestamptz,
  size_bytes bigint,
  local_path text,
  manifest_sha256 varchar(64),
  error_code varchar(80),
  error_message text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_jobs_org_created ON backup_jobs (organization_id, created_at DESC);

CREATE TABLE backup_job_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  job_id uuid NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES backup_storage_destinations(id) ON DELETE RESTRICT,
  status backup_target_status NOT NULL DEFAULT 'queued',
  remote_uri text,
  remote_size_bytes bigint,
  checksum_sha256 varchar(64),
  uploaded_at timestamptz,
  verified_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  error_code varchar(80),
  error_message text,
  UNIQUE (job_id, destination_id)
);

CREATE TABLE backup_restore_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  job_id uuid REFERENCES backup_jobs(id) ON DELETE SET NULL,
  destination_id uuid REFERENCES backup_storage_destinations(id) ON DELETE SET NULL,
  status backup_restore_status NOT NULL DEFAULT 'queued',
  test_environment varchar(120) NOT NULL DEFAULT 'sandbox-schema',
  verified_checks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  rpo_seconds integer,
  rto_seconds integer,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_restore_tests_org_created ON backup_restore_tests (organization_id, created_at DESC);
