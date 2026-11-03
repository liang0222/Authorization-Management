import Link from "next/link";
import { ShieldCheck } from "lucide-react";

/** 登录/找回密码布局：左侧品牌说明，右侧表单卡片。 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex">
        <div className="absolute -top-24 -right-24 size-72 rounded-full bg-primary/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 -left-16 size-80 rounded-full bg-info/10 blur-3xl" aria-hidden />
        <Link href="/login" className="relative flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            Z
          </span>
          <span className="text-sm font-semibold tracking-tight">子铭</span>
        </Link>
        <div className="relative max-w-md space-y-5">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            一个授权中心，管理四种交付形态
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            桌面 EXE、浏览器插件、微信小程序、网站后端共用同一套授权契约：签发、激活、心跳、解绑、续费、撤销，全部可审计。
          </p>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 text-primary" aria-hidden />
              管理状态与有效状态分离，暂停 / 撤销 / 到期各自独立展示。
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 text-primary" aria-hidden />
              授权码只存 HMAC 哈希，明文仅签发时展示一次。
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 text-primary" aria-hidden />
              周期按自然月计算，季度与一年不会退化成 90 / 365 天。
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">
          technical baseline: licensing_saas_technical_spec_v1.2
        </p>
      </div>
      <div className="flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
