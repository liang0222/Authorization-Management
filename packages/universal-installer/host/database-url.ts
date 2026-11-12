/**
 * 宿主的数据库连接串解析。
 *
 * 原实现读的是 Authorization-Management 的 `src/lib/config.ts`（`config.databaseUrl`）——
 * 那属于授权系统的业务模块，拆包后不能反向 import，故把规则抄到这里：
 * 先看 `LICENSE_DB_URL`，没有再回落到本机开发默认值。
 *
 * 为什么不能只读 `process.env.LICENSE_DB_URL`：生产环境文件里常常没有这一行
 * （靠 `src/lib/config.ts` 的 DEV_DEFAULTS 回退），只看 env 会把一个正常运行的
 * 实例判成「连不上库」。
 */
export const DEFAULT_DATABASE_URL =
  "postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public";

export function hostDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LICENSE_DB_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_DATABASE_URL;
}
