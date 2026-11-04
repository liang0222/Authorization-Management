/**
 * 站点入口的安装门禁。
 *
 * 为什么放在 Proxy 而不是 `src/app/page.tsx`：本项目开了 `cacheComponents`，
 * 页面里 `await connection()` 之后才 `redirect()` 时，响应头已经发出去了，
 * Next 只能退化成「客户端 meta 跳转」——无 JS 的客户端会停在一个空壳上，
 * 状态码也不是 307。Next 官方文档明确写了：要在渲染之前跳转，用 Proxy。
 *
 * 这里只看安装锁文件（纯 fs 检查，不连数据库），因为 Proxy 会先于一切路由执行，
 * 不能让它变慢或依赖 DB。锁不存在时会跳到 /install —— 那一页会做完整的
 * 五级状态判定（锁 / 数据库安装记录 / 项目自身信号 / 探测 / 默认），
 * 数据在但锁丢了的情况会被它识别为「已安装」并展示锁定页，而不是重装。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";

/** 与 core 的 store 保持一致的常量；Proxy 不 import core，避免把大模块图带进来。 */
const PROJECT_ID = "licensing-saas";
const DATA_ROOT = process.env.INSTALLER_DATA_DIR?.trim() || "/var/lib/universal-installer";

export function proxy(request: NextRequest) {
  const lockPath = join(DATA_ROOT, PROJECT_ID, "installed.lock");
  const url = request.nextUrl.clone();
  url.pathname = existsSync(lockPath) ? "/app/dashboard" : "/install";
  url.search = "";
  return NextResponse.redirect(url);
}

/** 只管根路径；其余路由完全不受影响。 */
export const config = {
  matcher: "/",
};
