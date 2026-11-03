import Link from "next/link";
import { ArrowRight, KeyRound, ShieldCheck, Webhook, Gauge } from "lucide-react";
import { DocsSection } from "@/components/developers/endpoint";
import { DocsHeader } from "@/components/developers/docs-shell";
import { CodeBlock } from "@/components/developers/code-block";
import { DOCS_SECTIONS, MACHINE_READABLE_FILES } from "@/lib/developers/docs-nav";
import { WEBHOOK_EVENT_TYPES } from "@/lib/services/webhook-events";

const HIGHLIGHTS = [
  {
    icon: KeyRound,
    title: "设备持有私钥",
    body: "客户端本地生成 Ed25519 密钥对，服务端只保存公钥；签名激活，密钥不出设备。",
  },
  {
    icon: ShieldCheck,
    title: "先验证再放行",
    body: "每次启动用短期 Token 校验，权限位随响应下发，断网时用离线授权兜底。",
  },
  {
    icon: Webhook,
    title: "状态推给你",
    body: `续费、暂停、吊销等 ${WEBHOOK_EVENT_TYPES.length} 个事件走 HMAC 签名的 Webhook，不用轮询。`,
  },
  {
    icon: Gauge,
    title: "配额可预期",
    body: "按产品、组织、IP 三层计数的固定窗口限流，超限返回 429 与 Retry-After。",
  },
];

export default function DevelopersIndexPage() {
  return (
    <>
      <DocsHeader
        badge="API v1"
        title="子铭软件授权 API"
        description="给你的桌面软件、浏览器扩展、小程序或网站后端接上授权校验。这份文档只讲公开 API：不需要登录后台，也不需要任何服务器密钥。"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {HIGHLIGHTS.map((item) => (
          <div key={item.title} className="rounded-lg border border-border p-4">
            <item.icon className="mb-2 size-4 text-primary" />
            <p className="text-sm font-medium text-foreground">{item.title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{item.body}</p>
          </div>
        ))}
      </div>

      <DocsSection title="30 秒看懂调用链">
        <p>
          授权的核心是一次「挑战—签名—激活」。服务端给随机数，设备用私钥签名，服务端用公钥验签。
          这样即使授权码泄露，没有设备私钥也无法完成激活。
        </p>
        <CodeBlock
          language="text"
          filename="调用顺序"
          code={`1. POST /api/v1/activation-challenges   拿到 challenge_id + nonce + canonical_message
2. 本地用设备私钥签名 canonical_message
3. POST /api/v1/activations               提交签名，拿到 access_token + refresh_token
4. POST /api/v1/activations/heartbeat     每 15 分钟续期一次，同时拿最新权限位
5. GET  /api/v1/activations/{id}/entitlements   需要单独确认权限时调用`}
        />
        <p>
          第一次接入建议直接看
          <Link href="/developers/quickstart" className="mx-1 text-primary underline-offset-2 hover:underline">
            快速开始
          </Link>
          ，那里有一份可以原样跑通的 Python 脚本。
        </p>
      </DocsSection>

      <DocsSection title="文档目录">
        <div className="grid gap-6 sm:grid-cols-2">
          {DOCS_SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="mb-2 text-xs font-medium tracking-wide text-foreground uppercase">
                {section.title}
              </p>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="group flex items-start gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
                    >
                      <ArrowRight className="mt-0.5 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                      <span>
                        <span className="text-foreground">{item.title}</span>
                        <span className="block text-[12px]">{item.description}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DocsSection>

      <DocsSection title="给 AI 与工具的入口">
        <p>
          如果你在让 AI 助手接这套 API，直接把下面两个地址给它，比让它读网页更省 token，也更不容易漏约束。
        </p>
        <ul className="space-y-1.5">
          {MACHINE_READABLE_FILES.map((file) => (
            <li key={file.path}>
              <a href={file.path} className="font-mono text-[12.5px] text-primary hover:underline">
                {file.path}
              </a>
              <span className="ml-2 text-[12px]">{file.description}</span>
            </li>
          ))}
        </ul>
      </DocsSection>

      <DocsSection title="两个地址，别混用">
        <CodeBlock
          language="text"
          filename="Base URL"
          code={`Production  https://<LICENSE_API_DOMAIN>/api/v1
Sandbox     https://<LICENSE_SANDBOX_DOMAIN>/api/v1   ← 开发期一律用这个`}
        />
        <p>
          Sandbox 与生产使用不同的数据库、不同的签名密钥、不同的产品凭证。任何写死生产域名、
          或者在客户端里塞服务端 Secret 的做法都会在联调阶段暴露问题——而且通常是在用户机器上暴露。
        </p>
      </DocsSection>
    </>
  );
}
