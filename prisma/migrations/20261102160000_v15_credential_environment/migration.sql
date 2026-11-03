-- v1.5 增量迁移：产品凭证的环境维度（规格 27.3「独立产品凭证」）。
--
-- 之前 product_credentials 只有一个凭证池：Sandbox 部署拿到的 client_id
-- 在生产进程里同样可用，等于两套环境共用同一把钥匙。加 environment 列后，
-- 运行时按进程的 DEPLOYMENT_ENV 过滤，Sandbox 进程看不到生产凭证，反之亦然。
--
-- 存量行一律归属 production：它们本来就是给现网准备的；
-- Sandbox 实例首次启动时由 scripts/sandbox-bootstrap 单独建一套。

CREATE TYPE "credential_environment" AS ENUM ('production', 'sandbox');

ALTER TABLE product_credentials
  ADD COLUMN environment "credential_environment" NOT NULL DEFAULT 'production';

COMMENT ON COLUMN product_credentials.environment IS
  '凭证所属部署环境：production / sandbox。运行时按进程 DEPLOYMENT_ENV 过滤，禁止跨环境使用（规格 27.3）。';

CREATE INDEX idx_product_credentials_environment ON product_credentials (environment);
