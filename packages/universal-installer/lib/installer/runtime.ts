/**
 * 安装器在 Next.js 进程里的接线层。
 *
 * 只做三件事：挑适配器、定位数据目录、给页面/路由一个带短缓存的读取入口。
 * 通用核心（store/state/lock/orchestrator…）不认识 Next.js，也不该认识。
 */
import { join } from "node:path";
import { hostDatabaseUrl } from "../../host/database-url";
import { LicensingSaasAdapter } from "./adapters/licensing-saas";
import { licensingSaasManifest, LICENSING_SAAS_PROJECT_ID } from "./adapters/licensing-saas/manifest";
import { readSnapshot } from "./orchestrator";
import { dataRoot, readLock } from "./store";
import { probeEnvironment } from "./env-probe";
import type { CheckItem, InstallSnapshot, ProjectManifest } from "./contract";

/** 项目根：Next.js 进程的 cwd（systemd 的 WorkingDirectory）。 */
export function projectDir(): string {
  return process.cwd();
}

export function adapter(): LicensingSaasAdapter {
  return new LicensingSaasAdapter(projectDir());
}

export function manifest(): ProjectManifest {
  return licensingSaasManifest;
}

/** 该项目专属的数据目录。 */
export function installDataDir(): string {
  return join(dataRoot(), LICENSING_SAAS_PROJECT_ID);
}

/* -------------------------------------------------------------- 门禁快照缓存 */

interface CacheEntry {
  at: number;
  snapshot: InstallSnapshot;
}

let gateCache: CacheEntry | null = null;
const GATE_TTL_MS = 5000;

/**
 * 给页面用的安装状态。
 *
 * 两条路径：
 *  - 有安装锁 → 直接返回（不碰数据库，这是已装实例的常态，必须快）；
 *  - 无锁 → 才去探测数据库，并且结果缓存 5 秒，避免根路径被打爆。
 *
 * 探测用的连接串取自 `config.databaseUrl` —— 也就是「应用此刻真正在用的库」。
 * 不能只读 process.env.LICENSE_DB_URL：生产环境文件里常常没有这一行（靠
 * DEV_DEFAULTS 回退），那会让一个正常运行的实例被判成 UNKNOWN 从而拒绝进后台。
 */
export async function readInstallGate(force = false): Promise<InstallSnapshot> {
  const dir = installDataDir();
  const databaseUrl = hostDatabaseUrl();

  if (readLock(dir)) {
    return readSnapshot({ adapter: adapter(), projectDir: projectDir(), databaseUrl });
  }

  if (!force && gateCache && Date.now() - gateCache.at < GATE_TTL_MS) {
    return gateCache.snapshot;
  }

  const snapshot = await readSnapshot({ adapter: adapter(), projectDir: projectDir(), databaseUrl });
  gateCache = { at: Date.now(), snapshot };
  return snapshot;
}

/** 状态变化后让缓存立刻失效（安装成功/失败都调用）。 */
export function invalidateInstallGate(): void {
  gateCache = null;
}

/* ------------------------------------------------------------------ 环境检测 */

let envCache: { at: number; checks: CheckItem[] } | null = null;
const ENV_TTL_MS = 15_000;

export async function readEnvironment(force = false): Promise<CheckItem[]> {
  if (!force && envCache && Date.now() - envCache.at < ENV_TTL_MS) {
    return envCache.checks;
  }
  const checks = await probeEnvironment({
    projectDir: projectDir(),
    dataDir: installDataDir(),
    writablePaths: licensingSaasManifest.writablePaths,
  });
  envCache = { at: Date.now(), checks };
  return checks;
}

export function invalidateEnvironment(): void {
  envCache = null;
}
