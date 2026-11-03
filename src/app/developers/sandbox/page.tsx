import type { Metadata } from "next";
import Link from "next/link";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection, ParamsTable } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "Sandbox" };

export default function SandboxPage() {
  return (
    <>
      <DocsHeader
        badge="开发期默认环境"
        title="Sandbox 测试环境"
        description="Sandbox 与生产是两套独立部署：不同数据库、不同签名密钥、不同产品凭证、不同授权码。在 Sandbox 里怎么折腾都不会影响真实客户。"
      />

      <DocsSection title="两个环境的边">
        <ParamsTable
          rows={[
            { name: "数据库", type: "完全隔离", required: true, description: "独立实例或独立 schema，不共享任何一张表" },
            { name: "签名密钥", type: "独立密钥对", required: true, description: "Sandbox 的私钥泄露不影响生产签发能力" },
            { name: "产品凭证", type: "独立 client_id", required: true, description: "生产凭证在 Sandbox 不存在，反之亦然" },
            { name: "限流计数", type: "独立命名空间", required: true, description: "联调时刷爆 Sandbox 配额不会影响生产租户" },
            { name: "Webhook", type: "独立端点配置", required: true, description: "Sandbox 事件不会推送到生产接收端" },
          ]}
        />
      </DocsSection>

      <DocsSection title="Sandbox 里能做什么">
        <ul className="list-disc space-y-1 pl-5">
          <li>随意签发授权：7 天试用、1 年、永久，随便造，不影响计费。</li>
          <li>暴力测试边界：设备上限、激活次数上限、过期、暂停、吊销，都可以在几秒内造出来。</li>
          <li>重复激活同一台设备，验证你的幂等键是否写对。</li>
          <li>把 Webhook 指向本机 localhost，看真实签名头。</li>
        </ul>
        <CodeBlock
          language="bash"
          filename="本机接收端"
          code={`# 用 Python 起一个最小的回调接收端，配合 ngrok 或本机开发时直接 localhost
python3 -m http.server 4011 --bind 127.0.0.1`}
        />
      </DocsSection>

      <DocsSection title="Sandbox 里不能做什么">
        <ul className="list-disc space-y-1 pl-5">
          <li>不要把 Sandbox 数据当成可以上线 —— 环境重置时全部清空，不会提前通知。</li>
          <li>不要在 Sandbox 里用真实客户邮箱、手机号、微信 openid。用假数据。</li>
          <li>不要把 Sandbox 域名硬编码进发布版本。用配置项，默认值才指向 Sandbox。</li>
        </ul>
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[13px] text-foreground">
          规格要求 SDK「不得写死生产域名，默认 Sandbox」。这条不是洁癖：默认生产意味着一次配置失误就能让测试流量打到真实客户账上。
        </p>
      </DocsSection>

      <DocsSection title="切到生产前检查清单">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Base URL 来自配置，不是常量。</li>
          <li>TLS 校验是开的（任何「为了联调先关掉」的开关都已经删掉）。</li>
          <li>日志里没有授权码、令牌、签名原文。</li>
          <li>429 有退避，401 不做无限重试。</li>
          <li>Webhook 接收端验签，且支持密钥轮换后的双密钥过渡。</li>
          <li>授权码只在激活时使用一次，不落盘到明文配置文件。</li>
        </ol>
        <p>
          需要测试数据时，可以直接在{" "}
          <Link href="/developers/quickstart" className="text-primary hover:underline">
            快速开始
          </Link>{" "}
          的脚本里把 <code className="font-mono text-[12.5px]">LICENSE_BASE_URL</code> 指到 Sandbox 地址。
        </p>
      </DocsSection>
    </>
  );
}
