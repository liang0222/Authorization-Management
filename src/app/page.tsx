import { redirect } from "next/navigation";
import { connection } from "next/server";

/** 入口每次请求都真跑一次跳转，不静态预渲染（与 Proxy 的行为保持一致）。 */
export const instant = false;

/**
 * 站点入口。
 *
 * **阶段 3 起不再判定安装状态**：安装器已拆到 `packages/universal-installer/`，
 * 授权系统自己不再有「未安装」这个状态——库迁移由部署流程负责（见 README §1.2）。
 * 因此这里恒定进后台；未登录会被后台的会话校验引导到 `/login`。
 */
export default async function RootPage() {
  await connection();
  redirect("/app/dashboard");
}
