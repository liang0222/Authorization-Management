import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 后台任务（Webhook 投递器、备份调度器）的启动闸门。
 *
 * 为什么需要闸门：全新实例在用户点"开始安装"之前，数据库里一张表都没有。
 * 这两个循环一旦跑起来就会查 `webhook_deliveries` / `backup_policies`，
 * 每 5 秒往日志里刷一条 `TableDoesNotExist`。日志被这种预期内的报错淹掉之后，
 * 真出问题时反而看不见——所以宁可晚起，也不要在装好之前反复报错。
 *
 * 判定用安装锁文件（纯 fs 检查，不连库、不 import 任何业务模块）：
 * - 锁在 → 已安装 → 允许启动
 * - 锁不在 → 未装 / 正在装 → 跳过，等 `/api/install/run` 成功后补起
 *
 * `DISABLE_*_WORKER=true` 仍然优先，用于测试与手工排查。
 */

const PROJECT_ID = "licensing-saas";

function dataRoot(): string {
  const custom = process.env.INSTALLER_DATA_DIR?.trim();
  return custom && custom.length > 0 ? custom : "/var/lib/universal-installer";
}

/** 已安装（锁文件存在）才允许起后台任务。 */
export function backgroundWorkersAllowed(): boolean {
  return existsSync(join(dataRoot(), PROJECT_ID, "installed.lock"));
}

/** 同一进程内只允许启动一次同名后台任务。 */
export function once(name: string): boolean {
  const key = `__ziming_worker_${name}__`;
  const globalRef = globalThis as unknown as Record<string, boolean | undefined>;
  if (globalRef[key]) return false;
  globalRef[key] = true;
  return true;
}

/**
 * 拉起后台任务。幂等：重复调用只会启动一次。
 * 安装器在 `finalize` 之后调用它，把启动期跳过的任务补起来，不用重启服务。
 */
export async function startBackgroundWorkers(): Promise<void> {
  if (process.env.DISABLE_WEBHOOK_WORKER !== "true" && once("webhook")) {
    const { startWebhookWorker } = await import("@/lib/services/webhook-dispatcher");
    startWebhookWorker();
  }

  if (process.env.DISABLE_BACKUP_SCHEDULER !== "true" && once("backup-scheduler")) {
    const { startBackupScheduler } = await import("@/lib/services/backup/scheduler");
    startBackupScheduler();
  }
}
