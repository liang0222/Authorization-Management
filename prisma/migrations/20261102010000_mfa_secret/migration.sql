-- 管理员 MFA（TOTP）密钥：仅保存 AES-256-GCM 加密后的密文，密钥来自环境变量。
-- 规格 users 表只定义了 mfa_enabled，实际启用 MFA 需要安全存储密文，故补充此列。
ALTER TABLE users ADD COLUMN mfa_secret_enc text;
