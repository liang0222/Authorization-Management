-- Webhook 投递需要明文 secret 参与 HMAC 签名，而 secret_hash 不可逆。
-- 因此新增一列存 AES-256-GCM 密文（key 由 SESSION_SECRET 派生），
-- 原 secret_hash 保留，仅用于「是否已配置」的判断与人工核对。
ALTER TABLE webhook_endpoints ADD COLUMN secret_enc text;
