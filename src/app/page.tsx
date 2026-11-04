import { redirect } from "next/navigation";
import { connection } from "next/server";
import { readInstallGate } from "@/lib/installer/runtime";

/** 安装门禁需要每次请求都真读状态，不能静态预渲染。 */
export const instant = false;

/**
 * 站点入口。
 *
 * 只有「已安装」与「维护中」进后台，其余一律去 /install：
 *   - 未安装 → 装
 *   - 安装失败 → 恢复
 *   - 状态未知（库连不上 / 锁坏了）→ 由安装页展示原因并禁止安装，
 *     比跳进一个连不上库的后台诚实得多。
 *
 * 判定不走 Cookie（清缓存带不来重装），只看安装锁与数据库安装记录，
 * 且 core 的 buildSnapshot 会把「库连不上」判成 UNKNOWN 而不是未安装。
 */
export default async function RootPage() {
  await connection();

  const snapshot = await readInstallGate();

  if (snapshot.state === "INSTALLED" || snapshot.state === "MAINTENANCE") {
    redirect("/app/dashboard");
  }

  redirect("/install");
}
