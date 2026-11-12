/**
 * 后台任务（Webhook 投递器、备份调度器）的启动闸门。
 *
 * **阶段 3 起不再看安装器状态**：判定只看「数据库是否就绪」——连得上库，
 * 且这两条循环要用的表已经建好。安装器已拆到 `packages/universal-installer/`，
 * 授权系统的启动不再依赖它是否装过（此前依赖 `installed.lock`，那个文件由安装器写，
 * 拆包后可能永远不存在，后台任务就再也起不来）。
 *
 * 为什么仍然要查表：全新实例在迁移跑完之前，这两条循环一启动就会查
 * `webhook_deliveries` / `backup_policies`，那时表还没建，于是每 5 秒往日志里刷一条
 * `TableDoesNotExist`——日志被这种预期内的报错淹掉之后，真出问题时反而看不见。
 * 现在闸门只看库：`prisma migrate deploy` 跑完、表在了，重启即自动拉起。
 *
 * `DISABLE_*_WORKER=true` 仍然优先，用于测试与手工排查。
 */

/** 两条后台循环各自要用的表；缺一个就不启动，避免日志刷屏。 */
const REQUIRED_TABLES = ["webhook_deliveries", "backup_policies"] as const;

export interface WorkerGateResult {
  /** 是否允许启动后台任务。 */
  allowed: boolean;
  /** 给人看的一句话结论（缺哪张表 / 连不上库的原因），不含口令。 */
  detail: string;
}

/** 连接串里不该进日志的部分统一抹掉。 */
function scrub(message: string): string {
  return message
    .replace(/(:\/\/[^:/@\s]+):[^@\s]*@/g, "$1:***@")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 数据库就绪探测。
 *
 * 只读 `to_regclass`，不碰业务表：库存在但迁移没跑 → 缺表 → 不就绪；
 * 库连不上 → 不就绪。两种情况都只返回原因，不抛异常（启动流程不该被探测本身搞崩；
 * 真正的配置错误由 `[boot]` 闸门负责硬拦截）。
 */
export async function databaseReadiness(): Promise<WorkerGateResult> {
  try {
    const { prisma } = await import("@/lib/db");
    const rows = await prisma.$queryRaw<Array<{ webhook: string | null; backup: string | null }>>`
      SELECT to_regclass('public.webhook_deliveries')::text AS webhook,
             to_regclass('public.backup_policies')::text AS backup
    `;
    const row = rows[0];
    const present: Record<string, boolean> = {
      webhook_deliveries: Boolean(row?.webhook),
      backup_policies: Boolean(row?.backup),
    };
    const missing = REQUIRED_TABLES.filter((name) => !present[name]);
    if (missing.length > 0) {
      return {
        allowed: false,
        detail: `数据库尚未就绪：缺表 ${missing.join("、")}（迁移还没跑，跑完重启即自动拉起）`,
      };
    }
    return { allowed: true, detail: "数据库就绪" };
  } catch (error) {
    const raw = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { allowed: false, detail: `数据库未就绪：${scrub(raw)}` };
  }
}

/** 后台任务是否可以启动（只看数据库，不看安装器）。 */
export async function backgroundWorkersAllowed(): Promise<WorkerGateResult> {
  return databaseReadiness();
}

/** 同一进程内只允许启动一次同名后台任务。 */
export function once(name: string): boolean {
  const key = `__ziming_worker_${name}__`;
  const globalRef = globalThis as unknown as Record<string, boolean | undefined>;
  if (globalRef[key]) return false;
  globalRef[key] = true;
  return true;
}

/** 拉起后台任务。幂等：重复调用只会启动一次。 */
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
