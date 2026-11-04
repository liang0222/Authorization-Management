import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "安装向导",
  description: "通用安装部署基础设施：环境检测、数据库配置、迁移、初始化与管理员创建。",
  robots: { index: false, follow: false },
};

/**
 * 安装页使用独立布局：不套后台侧边栏，也不加载业务导航。
 * 这样即使数据库还没建表，页面本身也能正常渲染。
 */
export default function InstallLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-background">{children}</div>;
}
