-- v1.5 增量迁移：备份保留策略的落地标记（规格 16.11.3）。
--
-- 保留策略（daily/weekly/monthly）此前只是 backup_policies.retention_json 里的一串数字，
-- 没有任何代码删过旧备份，磁盘只增不减。实现清理之后需要一个幂等标记：
-- 已清理的作业不再参与下一轮评估，否则每次都要重新尝试删除早已不存在的对象。
--
-- 刻意只清文件、不删作业行：backup_jobs 是「某天到底有没有备份成功」的审计凭据。

ALTER TABLE backup_jobs ADD COLUMN purged_at timestamptz(6);

COMMENT ON COLUMN backup_jobs.purged_at IS
  '保留策略清掉该作业备份文件的时间；非空表示本地暂存与远端对象均已删除，作业记录保留。';

CREATE INDEX idx_backup_jobs_retention
  ON backup_jobs (policy_id, created_at DESC)
  WHERE purged_at IS NULL;
