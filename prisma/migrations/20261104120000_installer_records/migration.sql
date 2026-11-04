-- Universal Installer 安装记录。
-- 与本地安装锁共同校验安装状态：锁被删但这里有行 → 判定已安装并告警，不允许重装。
CREATE TABLE "installer_records" (
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

CREATE UNIQUE INDEX "installer_records_project_id_key" ON "installer_records"("project_id");
