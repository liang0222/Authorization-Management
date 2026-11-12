-- Universal Installer 自己的安装记录表。
--
-- 阶段 3 之前这张表由授权系统（Authorization-Management）的 prisma/schema.prisma 定义；
-- 拆分后归属本包，由安装器在建库流程里创建/维护。授权系统已不再读写它，
-- 但**不删除、不清空**：已部署实例里的历史记录原样保留。
--
-- 与迁移历史里 20261104120000_installer_records 的 DDL 完全一致（幂等写法，
-- 对已有表执行是空操作，不会改动任何行）。
CREATE TABLE IF NOT EXISTS "installer_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" VARCHAR(80) NOT NULL,
    "project_version" VARCHAR(40) NOT NULL,
    "installer_version" VARCHAR(40) NOT NULL,
    "adapter" VARCHAR(80) NOT NULL,
    "manifest_sha256" VARCHAR(64) NOT NULL,
    "installed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installed_by" VARCHAR(254),
    "attempt_id" VARCHAR(80),
    "detail" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "installer_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "installer_records_project_id_key"
    ON "installer_records"("project_id");
