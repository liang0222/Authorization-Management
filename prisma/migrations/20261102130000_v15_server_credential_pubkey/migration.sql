-- v1.5 增量迁移 2：机密服务端凭证的公钥（用于 private_key_jwt 断言验签）。

ALTER TABLE product_credentials
  ADD COLUMN public_key bytea;

COMMENT ON COLUMN product_credentials.public_key IS
  '机密服务端凭证的 Ed25519 公钥（SPKI DER）。公开客户端为 NULL；服务端用它验签 subject assertion / client_assertion。';

-- 只约束新数据：存量机密凭证在补公钥之前不阻塞迁移。
ALTER TABLE product_credentials
  ADD CONSTRAINT product_credentials_server_pubkey_ck
  CHECK (credential_type <> 'confidential_server' OR public_key IS NOT NULL) NOT VALID;
