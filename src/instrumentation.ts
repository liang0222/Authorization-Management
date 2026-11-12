import { config, productionSafetyIssues } from "@/lib/config";
import { backgroundWorkersAllowed, startBackgroundWorkers } from "@/lib/background";

/**
 * 服务端启动钩子。
 *
 * 这里做两件事，顺序不能反：
 * 1. **环境安全闸门**：`NODE_ENV=production` 时校验密钥与配置，有任何一条不通过就让启动失败
 *    （与 `DEPLOYMENT_ENV` 无关，判定见 `bootMustFail`）。
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

/**
 * 是否必须让启动失败。
 *
 * **只看 `NODE_ENV`**：生产构建（`NODE_ENV=production`）一律硬拦截，与 `DEPLOYMENT_ENV` 无关。
 * 早先这里判的是 `config.deploymentEnv === "production"`，于是
 * `NODE_ENV=production` + `DEPLOYMENT_ENV=development` + 开发默认密钥 + `DEV_MAIL_SINK=true`
 * 只打一行警告就照常启动——闸门形同虚设（阶段 1 前的实测结论）。
 *
 * 独立导出是为了让单测直接验证判定，不必真的拉起 Next。
 */
export function bootMustFail(issues: string[]): boolean {
  return config.isProduction && issues.length > 0;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const issues = bootSafetyIssues();
  if (issues.length > 0) {
    const header = `[boot] NODE_ENV=${process.env.NODE_ENV ?? "未设置"} env=${config.deploymentEnv} 配置检查未通过：`;
    if (bootMustFail(issues)) {
      const message = `${header}\n- ${issues.join("\n- ")}`;
      /**
       * 只 throw 不够：Next 16 会把 instrumentation 的异常包成
       * `Failed to prepare server Error: An error occurred while loading instrumentation hook`
       * 然后**继续监听端口**，每个请求回 500，而 systemd 看到的是 `active`，
       * `Restart=on-failure` 不会触发，运维只会看到「服务在跑但全 500」（阶段 1 实测）。
       * 生产构建配置不合法时，半活比直接死更危险：健康检查探不到、重启不生效、
       * 还可能被误认为「已经在跑」。所以这里先按原样打印完整 issue 清单，
       * 再显式 `process.exit(1)`——语义上就是「启动失败」，只是绕开了 Next 的吞异常。
       */
      console.error(message);
      process.exit(1);
    }
    console.warn(`${header}\n- ${issues.join("\n- ")}`);
  } else {
    console.log(
      `[boot] env=${config.deploymentEnv} signingKeyDir=${config.signingKeyDir} backupDir=${config.backupLocalDir} 配置检查通过`,
    );
  }

  /**
   * 后台任务要等装完再起。
   *
   * 全新实例上这两条循环一启动就会查 `webhook_deliveries` / `backup_policies`，
   * 而那时表还没建（安装器要等用户提交表单才跑迁移），于是每 5 秒往日志里刷一条
   * `TableDoesNotExist`。日志里混着这种「预期内的报错」，真出问题时反而看不见。
   *
   * 判定只看安装锁文件（纯 fs，不连库）：装完 `finalize` 会写锁，
   * 随后 `/api/install/run` 的成功分支会调用 `startBackgroundWorkers()` 补起。
   */
  if (!backgroundWorkersAllowed()) {
    console.log("[boot] 尚未安装，跳过后台任务（安装完成后自动启动）");
    return;
  }

  await startBackgroundWorkers();
}
