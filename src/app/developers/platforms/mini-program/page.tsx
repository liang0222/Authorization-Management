import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "微信小程序" };

export default function MiniProgramPage() {
  return (
    <>
      <DocsHeader
        title="微信小程序"
        description="小程序代码能被反编译。它只能调你自己的后端，后端再用 private_key_jwt 调授权服务。"
      />

      <DocsSection title="为什么不能直连">
        <ul className="list-disc space-y-1 pl-5">
          <li>小程序包可被解包，任何放进来的 Secret 都等于公开。</li>
          <li>小程序的域名白名单只允许 https，但拦不住有人把请求转发到自己的服务器。</li>
          <li>授权服务的私钥必须只在服务器内存里，不能下发到任何客户端。</li>
        </ul>
        <CodeBlock
          language="text"
          filename="正确链路"
          code={`小程序  --(wx.login code)-->  你的后端
你的后端 --(code2session 换 openid)--> 微信
你的后端 --(private_key_jwt + openid)--> POST /server/licenses/check
你的后端 --(自定义登录态)-->  小程序`}
        />
      </DocsSection>

      <DocsSection title="后端调用的样子">
        <CodeBlock
          language="javascript"
          filename="Node 后端片段"
          code={`const assertion = signAssertion();   // iss/sub=client_id, aud=license-api, jti 一次性

const res = await fetch(\`\${BASE}/server/licenses/check\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_assertion: assertion,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    identity: { provider: "wechat_mini_program", subject_token: openid },
    required_features: ["export_pdf"],
  }),
});

const { data } = await res.json();
if (!data.authorized) {
  // effective_status 仍可能是 active —— 那只是缺功能，应该降级而不是拒绝登录
  return { plan: "free", missing: data.missing_features };
}`}
        />
      </DocsSection>

      <DocsSection title="身份怎么对上">
        <p>
          <code className="font-mono text-[12.5px]">subject_token</code> 传什么由你决定，服务端只存它的 SHA-256。
          传 openid 最直接；传内部 user_id 更隐私友好（服务端拿不到微信身份）。
        </p>
        <p className="text-[13px]">
          同一 provider 下 subject_token 必须稳定 —— 用 openid 而不是 session_key，后者会变。
        </p>
      </DocsSection>
    </>
  );
}
