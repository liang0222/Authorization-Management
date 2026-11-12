/**
 * 站点入口跳转。
 *
 * 为什么放在 Proxy 而不是 `src/app/page.tsx`：本项目开了 `cacheComponents`，
 * 页面里 `await connection()` 之后才 `redirect()` 时，响应头已经发出去了，
 * Next 只能退化成「客户端 meta 跳转」——无 JS 的客户端会停在一个空壳上，
 * 状态码也不是 307。Next 官方文档明确写了：要在渲染之前跳转，用 Proxy。
 *
 * **阶段 3 起与安装器完全解耦**：安装器已拆到 `packages/universal-installer/`，
 * 授权系统的入口不再判断「装没装过」（原先锁文件不存在就甩到 `/install`，
 * 而那个页面随拆包一起离开了本仓库，再按旧逻辑跳就是 404）。
 * 现在入口恒定进后台：库没就绪时后台自己会给出「连不上库」的错误页，
 * 比入口静默跳到一个不存在的安装页诚实。
 */
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/app/dashboard";
  url.search = "";
  return NextResponse.redirect(url);
}

/** 只管根路径；其余路由完全不受影响。 */
export const config = {
  matcher: "/",
};
