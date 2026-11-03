import { config, productionSafetyIssues } from "@/lib/config";

/**
 * 服务端启动钩子。
 *
 * 这里做两件事，顺序不能反：
 * 1. **环境安全闸门**：`DEPLOYMENT_ENV=production` 时校验密钥与配置，不通过就让启动失败。
 *    放在后台任务之前，是因为带着开发默认私钥跑起来再报警已经太晚——那段时间里
 *    签发的授权都是用可预测密钥签的。
 * 2. **常驻后台任务**：Webhook 投递器、备份调度器。Next 的 route handler 是被动的，
 *    没人请求就不会执行；而这些任务必须按时推进，只能由 `register()` 拉起。
 *
 * 注意：
 * - 只在 nodejs runtime 启动（edge 没有长连接与 Prisma）。
 * - `globalThis` 上打标记，避免 dev 模式热重载反复启动多个定时器。
 * - 单实例内串行执行；多实例靠数据库的 `FOR UPDATE SKIP LOCKED` 天然互斥。
 */

/** 同一进程内只允许启动一次同名后台任务。 */
function once(name: string): boolean {
  const key = `__ziming_worker_${name}__`;
  const globalRef = globalThis as unknown as Record<string, boolean | undefined>;
  if (globalRef[key]) return false;
  globalRef[key] = true;
  return true;
}

/**
 * 启动前的配置校验。返回问题列表，空数组表示通过。
 * 独立导出是为了让单测能在不启动 Next 的情况下验证判定逻辑。
 */
export function bootSafetyIssues(): string[] {
  const issues = productionSafetyIssues();

  /**
   * 目录名归一化：`./.keys`、`.keys/`、`.keys` 视为同一处。
   * 只比较「裸目录名」而不是绝对路径，是因为容器里 `/app/.keys` 与宿主 `.keys`
   * 本来就是两个不同的卷，不该被误判；真正的共用发生在同一条相对路径上。
   */
  const normalizeDir = (dir: string) => dir.trim().replace(/^\.\//, "").replace(/\/+$/, "");

  // 只有 sandbox 身份才强制「不得与生产共用密钥/备份目录」。
  if (config.deploymentEnv === "sandbox" && normalizeDir(config.signingKeyDir) === ".keys") {
    issues.push("Sandbox 的 SIGNING_KEY_DIR 不能与生产共用 .keys");
  }
  if (config.deploymentEnv === "sandbox" && normalizeDir(config.backupLocalDir) === ".backups") {
    issues.push("Sandbox 的 BACKUP_LOCAL_DIR 不能与生产共用 .backups");
  }
  return issues;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const issues = bootSafetyIssues();
  if (issues.length > 0) {
    const header = `[boot] ${config.deploymentEnv} 环境配置检查未通过：`;
    if (config.deploymentEnv === "production") {
      // 直接抛：Next 把启动标记为失败，systemd 的 Restart=on-failure 会重试，
      // 运维在 journalctl 里立刻看到原因，而不是跑了几周才发现密钥是默认值。
      throw new Error(`${header}\n- ${issues.join("\n- ")}`);
    }
    console.warn(`${header}\n- ${issues.join("\n- ")}`);
  } else {
    console.log(
      `[boot] env=${config.deploymentEnv} signingKeyDir=${config.signingKeyDir} backupDir=${config.backupLocalDir} 配置检查通过`,
    );
  }

  if (process.env.DISABLE_WEBHOOK_WORKER !== "true" && once("webhook")) {
    const { startWebhookWorker } = await import("@/lib/services/webhook-dispatcher");
    startWebhookWorker();
  }

  if (process.env.DISABLE_BACKUP_SCHEDULER !== "true" && once("backup-scheduler")) {
    const { startBackupScheduler } = await import("@/lib/services/backup/scheduler");
    startBackupScheduler();
  }
}
