-- =============================================================================
-- 通用软件授权管理 SaaS — 初始数据库结构
-- 基线：licensing_saas_technical_spec_v1.2.md（第 2 节 数据库规范）
-- 说明：
--   1. 本文件是唯一的 DDL 事实来源；部分唯一索引、复合外键、CHECK 约束都在这里维护。
--   2. Prisma 仅用于类型安全的查询，schema.prisma 由本数据库自省（db pull）生成。
--   3. 新增表 admin_sessions / password_reset_tokens 属于管理后台会话与密码找回的
--      支撑表，不改变规格中任何业务表语义，已在 docs/PAGE_MAP.md 记录。
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------------
CREATE TYPE record_status AS ENUM ('active', 'disabled', 'archived');
CREATE TYPE product_type AS ENUM ('desktop', 'browser_extension', 'mini_program', 'web', 'server', 'other');
CREATE TYPE license_admin_status AS ENUM ('draft', 'pending', 'active', 'suspended', 'revoked', 'cancelled');
CREATE TYPE activation_status AS ENUM ('active', 'released', 'revoked', 'blocked');
CREATE TYPE duration_unit AS ENUM ('day', 'month', 'lifetime');
CREATE TYPE start_policy AS ENUM ('on_first_activation', 'fixed_start');
CREATE TYPE credential_type AS ENUM ('public_client', 'confidential_server');
CREATE TYPE signing_key_status AS ENUM ('staged', 'active', 'retiring', 'revoked');
CREATE TYPE identity_provider AS ENUM ('wechat_mini_program', 'google', 'microsoft', 'email', 'phone', 'custom');
CREATE TYPE identity_status AS ENUM ('active', 'disabled', 'unlinked');
CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'delivering', 'succeeded', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- A. 组织、管理员与 RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  slug varchar(80) NOT NULL UNIQUE,
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  status record_status NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(254) NOT NULL,
  password_hash text NOT NULL,
  display_name varchar(120) NOT NULL,
  status record_status NOT NULL DEFAULT 'active',
  mfa_enabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  code varchar(80) NOT NULL,
  name varchar(120) NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE permissions (
  code varchar(120) PRIMARY KEY,
  description varchar(255) NOT NULL
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code varchar(120) NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_memberships_user ON organization_memberships(user_id, status);

-- ---------------------------------------------------------------------------
-- B. 软件产品、产品功能、凭证和签名密钥
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code varchar(80) NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  product_type product_type NOT NULL,
  status record_status NOT NULL DEFAULT 'active',
  current_version varchar(80),
  supported_platforms text[] NOT NULL DEFAULT '{}',
  heartbeat_interval_seconds integer NOT NULL DEFAULT 900 CHECK (heartbeat_interval_seconds BETWEEN 60 AND 86400),
  access_token_ttl_seconds integer NOT NULL DEFAULT 600 CHECK (access_token_ttl_seconds BETWEEN 60 AND 3600),
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_products_org_status ON products(organization_id, status, created_at DESC);

CREATE TABLE product_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  code varchar(100) NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  value_type varchar(20) NOT NULL DEFAULT 'boolean' CHECK (value_type IN ('boolean','number','string','json')),
  default_value jsonb NOT NULL DEFAULT 'true'::jsonb,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  UNIQUE (product_id, code),
  UNIQUE (id, product_id, organization_id)
);
CREATE INDEX idx_product_features_product_status ON product_features(product_id, status);

CREATE TABLE product_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  credential_type credential_type NOT NULL,
  client_id varchar(100) NOT NULL UNIQUE,
  secret_hash bytea,
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_origins text[] NOT NULL DEFAULT '{}',
  status record_status NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  CHECK ((credential_type = 'public_client' AND secret_hash IS NULL) OR
         (credential_type = 'confidential_server' AND secret_hash IS NOT NULL))
);
CREATE INDEX idx_product_credentials_product ON product_credentials(product_id, status);

CREATE TABLE signing_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid,
  kid varchar(100) NOT NULL UNIQUE,
  algorithm varchar(20) NOT NULL DEFAULT 'EdDSA' CHECK (algorithm = 'EdDSA'),
  public_key bytea NOT NULL,
  private_key_ref text NOT NULL,
  status signing_key_status NOT NULL DEFAULT 'staged',
  not_before timestamptz NOT NULL,
  not_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  CHECK (not_after IS NULL OR not_after > not_before)
);
CREATE INDEX idx_signing_keys_product_status ON signing_keys(product_id, status);

-- ---------------------------------------------------------------------------
-- C. 客户、客户外部身份
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  customer_code varchar(80),
  name varchar(160) NOT NULL,
  email varchar(254),
  phone varchar(40),
  company_name varchar(160),
  notes text,
  status record_status NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX uq_customers_org_code ON customers(organization_id, customer_code) WHERE customer_code IS NOT NULL;
CREATE INDEX idx_customers_org_name ON customers(organization_id, name);
CREATE INDEX idx_customers_org_email ON customers(organization_id, lower(email));

CREATE TABLE customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  provider identity_provider NOT NULL,
  subject_hash bytea NOT NULL,
  display_name varchar(160),
  status identity_status NOT NULL DEFAULT 'active',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, organization_id) REFERENCES customers(id, organization_id),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  UNIQUE (product_id, provider, subject_hash),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_customer_identities_customer ON customer_identities(customer_id, status);

-- ---------------------------------------------------------------------------
-- D. 授权套餐和套餐功能
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  code varchar(80) NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  duration_unit duration_unit NOT NULL,
  duration_value integer NOT NULL DEFAULT 0,
  start_policy start_policy NOT NULL DEFAULT 'on_first_activation',
  activation_deadline_days integer,
  max_devices integer NOT NULL DEFAULT 1 CHECK (max_devices >= 1),
  max_activation_count integer CHECK (max_activation_count IS NULL OR max_activation_count >= 1),
  max_subjects integer CHECK (max_subjects IS NULL OR max_subjects >= 1),
  refund_activation_on_release boolean NOT NULL DEFAULT false,
  offline_allowed boolean NOT NULL DEFAULT false,
  offline_grace_seconds integer NOT NULL DEFAULT 0 CHECK (offline_grace_seconds >= 0),
  default_features jsonb NOT NULL DEFAULT '{}'::jsonb,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  UNIQUE (product_id, code),
  UNIQUE (id, product_id, organization_id),
  CHECK ((duration_unit = 'lifetime' AND duration_value = 0) OR
         (duration_unit IN ('day','month') AND duration_value > 0)),
  CHECK (activation_deadline_days IS NULL OR activation_deadline_days >= 0)
);
CREATE INDEX idx_plans_product_status ON plans(product_id, status);

CREATE TABLE plan_features (
  plan_id uuid NOT NULL,
  product_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  feature_code varchar(100) NOT NULL,
  feature_value jsonb NOT NULL,
  PRIMARY KEY (plan_id, feature_code),
  FOREIGN KEY (plan_id, product_id, organization_id) REFERENCES plans(id, product_id, organization_id),
  FOREIGN KEY (product_id, feature_code) REFERENCES product_features(product_id, code)
);

-- ---------------------------------------------------------------------------
-- E. 授权主体、兑换码、功能覆盖和续费
-- ---------------------------------------------------------------------------
CREATE TABLE licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  plan_id uuid,
  external_order_id varchar(120),
  admin_status license_admin_status NOT NULL DEFAULT 'pending',
  duration_unit duration_unit NOT NULL,
  duration_value integer NOT NULL,
  start_policy start_policy NOT NULL DEFAULT 'on_first_activation',
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  starts_at timestamptz,
  expires_at timestamptz,
  activation_deadline_at timestamptz,
  max_devices integer NOT NULL DEFAULT 1 CHECK (max_devices >= 1),
  max_activation_count integer CHECK (max_activation_count IS NULL OR max_activation_count >= 1),
  activation_count integer NOT NULL DEFAULT 0 CHECK (activation_count >= 0),
  max_subjects integer CHECK (max_subjects IS NULL OR max_subjects >= 1),
  refund_activation_on_release boolean NOT NULL DEFAULT false,
  offline_allowed boolean NOT NULL DEFAULT false,
  offline_grace_seconds integer NOT NULL DEFAULT 0 CHECK (offline_grace_seconds >= 0),
  feature_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  FOREIGN KEY (customer_id, organization_id) REFERENCES customers(id, organization_id),
  FOREIGN KEY (plan_id, product_id, organization_id) REFERENCES plans(id, product_id, organization_id),
  UNIQUE (id, organization_id),
  UNIQUE (id, product_id, organization_id),
  CHECK ((duration_unit = 'lifetime' AND duration_value = 0 AND expires_at IS NULL) OR
         (duration_unit IN ('day','month') AND duration_value > 0)),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX idx_licenses_org_product_status ON licenses(organization_id, product_id, admin_status, created_at DESC);
CREATE INDEX idx_licenses_customer ON licenses(customer_id, created_at DESC);
CREATE INDEX idx_licenses_expiry ON licenses(expires_at) WHERE admin_status IN ('pending','active');
CREATE INDEX idx_licenses_external_order ON licenses(organization_id, external_order_id) WHERE external_order_id IS NOT NULL;

CREATE TABLE license_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  license_id uuid NOT NULL,
  key_prefix varchar(16) NOT NULL,
  key_last4 varchar(4) NOT NULL,
  key_hash bytea NOT NULL,
  hash_key_version varchar(40) NOT NULL,
  status record_status NOT NULL DEFAULT 'active',
  valid_until timestamptz,
  first_redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (license_id, organization_id) REFERENCES licenses(id, organization_id),
  UNIQUE (key_hash)
);
CREATE INDEX idx_license_keys_license ON license_keys(license_id, status);
CREATE INDEX idx_license_keys_prefix ON license_keys(key_prefix, key_last4);

CREATE TABLE license_features (
  license_id uuid NOT NULL,
  product_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  feature_code varchar(100) NOT NULL,
  feature_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (license_id, feature_code),
  FOREIGN KEY (license_id, product_id, organization_id) REFERENCES licenses(id, product_id, organization_id),
  FOREIGN KEY (product_id, feature_code) REFERENCES product_features(product_id, code)
);

CREATE TABLE license_renewals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  license_id uuid NOT NULL,
  duration_unit duration_unit NOT NULL,
  duration_value integer NOT NULL,
  previous_expires_at timestamptz,
  renewal_starts_at timestamptz NOT NULL,
  new_expires_at timestamptz,
  renewal_mode varchar(20) NOT NULL DEFAULT 'append' CHECK (renewal_mode IN ('append','from_now','manual_adjustment')),
  external_payment_ref varchar(160),
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (license_id, organization_id) REFERENCES licenses(id, organization_id)
);
CREATE INDEX idx_license_renewals_license ON license_renewals(license_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- F. 设备、激活、激活挑战和账号绑定
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  device_instance_id varchar(120) NOT NULL,
  platform varchar(40) NOT NULL,
  device_name varchar(160),
  public_key bytea,
  public_key_thumbprint varchar(128),
  fingerprint_hash bytea,
  status record_status NOT NULL DEFAULT 'active',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  UNIQUE (product_id, device_instance_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX idx_devices_product_status ON devices(product_id, status, last_seen_at DESC);
CREATE INDEX idx_devices_fingerprint ON devices(product_id, fingerprint_hash) WHERE fingerprint_hash IS NOT NULL;

CREATE TABLE activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  license_id uuid NOT NULL,
  device_id uuid NOT NULL,
  status activation_status NOT NULL DEFAULT 'active',
  activated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  revoked_at timestamptz,
  client_version varchar(80),
  credential_hash bytea,
  credential_version integer NOT NULL DEFAULT 1,
  token_version integer NOT NULL DEFAULT 1,
  last_ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (license_id, organization_id) REFERENCES licenses(id, organization_id),
  FOREIGN KEY (device_id, organization_id) REFERENCES devices(id, organization_id),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX uq_activation_license_device_active
  ON activations(license_id, device_id) WHERE status = 'active';
CREATE UNIQUE INDEX uq_activation_product_device_active
  ON activations(product_id, device_id) WHERE status = 'active';
CREATE INDEX idx_activations_license_status ON activations(license_id, status, activated_at DESC);
CREATE INDEX idx_activations_device_status ON activations(device_id, status);
CREATE INDEX idx_activations_last_seen ON activations(last_seen_at DESC) WHERE status = 'active';

-- 设备挑战：nonce 一次性消费，短期有效（4.6）
CREATE TABLE activation_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  challenge_id uuid NOT NULL UNIQUE,
  nonce text NOT NULL,
  device_instance_id varchar(120) NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id)
);
CREATE INDEX idx_activation_challenges_expiry ON activation_challenges(expires_at);

-- Refresh Token 历史表：用于轮换、旧令牌重放检测和会话族撤销。
CREATE TABLE activation_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  token_family_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES activation_refresh_tokens(id),
  FOREIGN KEY (activation_id, organization_id) REFERENCES activations(id, organization_id)
);
CREATE INDEX idx_refresh_tokens_activation ON activation_refresh_tokens(activation_id, issued_at DESC);
CREATE INDEX idx_refresh_tokens_family ON activation_refresh_tokens(token_family_id, issued_at DESC);
CREATE INDEX idx_refresh_tokens_expiry ON activation_refresh_tokens(expires_at);

CREATE TABLE activation_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  event_type varchar(60) NOT NULL,
  actor_type varchar(30) NOT NULL,
  actor_id uuid,
  request_id varchar(100),
  ip inet,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (activation_id, organization_id) REFERENCES activations(id, organization_id)
);
CREATE INDEX idx_activation_events_activation ON activation_events(activation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- G. 离线授权、幂等、审计、API 日志和 Webhook
-- ---------------------------------------------------------------------------
CREATE TABLE offline_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  license_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  signing_key_id uuid NOT NULL REFERENCES signing_keys(id),
  serial varchar(100) NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  payload jsonb NOT NULL,
  payload_hash bytea NOT NULL,
  signature bytea NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (license_id, organization_id) REFERENCES licenses(id, organization_id),
  FOREIGN KEY (activation_id, organization_id) REFERENCES activations(id, organization_id),
  CHECK (valid_until > issued_at)
);
CREATE INDEX idx_offline_grants_license ON offline_grants(license_id, valid_until DESC);

CREATE TABLE idempotency_records (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  scope varchar(120) NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  request_hash bytea NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (product_id, scope, idempotency_key)
);
CREATE INDEX idx_idempotency_expiry ON idempotency_records(expires_at);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL,
  actor_type varchar(30) NOT NULL,
  actor_id uuid,
  action varchar(120) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id uuid,
  before_data jsonb,
  after_data jsonb,
  request_id varchar(100),
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_time ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id, created_at DESC);

CREATE TABLE api_request_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid,
  product_id uuid,
  request_id varchar(100) NOT NULL,
  method varchar(10) NOT NULL,
  route varchar(180) NOT NULL,
  response_status integer NOT NULL,
  error_code varchar(80),
  latency_ms integer NOT NULL,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_logs_product_time ON api_request_logs(product_id, created_at DESC);
CREATE INDEX idx_api_logs_org_status_time ON api_request_logs(organization_id, response_status, created_at DESC);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  url text NOT NULL,
  secret_hash bytea NOT NULL,
  event_types text[] NOT NULL,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id)
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  event_id varchar(100) NOT NULL,
  event_type varchar(100) NOT NULL,
  payload jsonb NOT NULL,
  status webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  response_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- H. 管理后台会话与密码找回（支撑表，不改变业务表语义）
-- ---------------------------------------------------------------------------
CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE,
  csrf_token_hash bytea NOT NULL,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX idx_admin_sessions_user ON admin_sessions(user_id, expires_at DESC);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);
