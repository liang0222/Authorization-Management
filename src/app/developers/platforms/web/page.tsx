import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "网站后端" };

export default function WebPage() {
  return (
    <>
      <DocsHeader
        title="网站后端"
        description="服务端对服务端：用 private_key_jwt 断言换授权结果。私钥只在服务器上，可放 KMS 或容器 secret。"
      />

      <DocsSection title="放在哪一层">
        <CodeBlock
          language="text"
          filename="推荐分层"
          code={`浏览器  --session cookie-->  你的 Web 后端
你的 Web 后端 --(断言 + 用户身份)--> /server/licenses/check
你的 Web 后端 --(渲染/接口)-->  浏览器

不要：浏览器直连授权服务（会暴露 client_id 用途、配额、错误细节）`}
        />
      </DocsSection>

      <DocsSection title="私钥管理">
        <ul className="list-disc space-y-1 pl-5">
          <li>私钥只存服务器，通过环境变量或 KMS 注入，<strong className="text-foreground">不进镜像层</strong>。</li>
          <li>开发环境与生产用不同凭证。生产私钥不进开发者本机。</li>
          <li>轮换：先在服务端支持双密钥（kid 路由），再在后台轮换，最后移除旧密钥。</li>
        </ul>
        <p className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-[13px] text-foreground">
          任何「把私钥写进前端构建产物」的做法都会在第一次上线后被发现 —— 通常是被人拿去刷接口的时候。
        </p>
      </DocsSection>

      <DocsSection title="缓存策略">
        <p>
          <code className="font-mono text-[12.5px]">/server/licenses/check</code> 每次都打数据库。
          高 QPS 场景下建议在业务侧缓存 30–60 秒，键用
          <code className="font-mono mx-1 text-[12.5px]">(product_id, provider, subject)</code>，
          并在收到 <code className="font-mono text-[12.5px]">entitlements.updated</code> Webhook 时主动失效。
        </p>
        <p className="text-[13px]">
          不要缓存超过 5 分钟：授权被暂停后用户还能用 5 分钟以上，是真实的安全问题。
        </p>
      </DocsSection>

      <DocsSection title="错误处理建议">
        <CodeBlock
          language="python"
          filename="降级而不是拦截"
          code={`result = client.check(identity=openid, features=["export_pdf"])

if result.authorized:
    grant_all(result.entitlements)
elif result.effective_status == "active":
    # 授权有效，只是缺某个功能 → 降级
    grant_base_without(result.missing_features)
elif result.effective_status in ("suspended", "revoked", "cancelled"):
    # 明确不可用 → 提示续费或联系客服
    show_notice(result.effective_status)
else:
    # 过期 / 未激活
    show_activation_prompt()`}
        />
      </DocsSection>
    </>
  );
}
