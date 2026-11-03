import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection, ParamsTable } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "认证" };

export default function AuthenticationPage() {
  return (
    <>
      <DocsHeader
        title="认证"
        description="先按你的接入形态选一种方式。选错了不是「能不能用」的问题，而是密钥会不会泄露的问题。"
      />

      <DocsSection title="先对号入座">
        <ParamsTable
          caption="四种接入形态"
          rows={[
            { name: "EXE / 桌面客户端", type: "X-Client-ID + 设备签名", required: true, description: "公开客户端。密钥在用户机器上，只能用 Ed25519 设备签名，不能放 Secret" },
            { name: "浏览器扩展", type: "OAuth Code + PKCE", required: true, description: "扩展里没有安全存储，用 PKCE 换短时代码，不落 refresh 到扩展内" },
            { name: "微信小程序", type: "只调自己的后端", required: true, description: "小程序代码可被反编译，绝不能直连授权 API 或持有 Secret" },
            { name: "网站 / 小程序后端", type: "private_key_jwt 或 mTLS", required: true, description: "可信服务端。用断言换 token，Secret 只存在服务器" },
          ]}
        />
        <p className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-[13px] text-foreground">
          最常见的错误：把 confidential_server 的 Secret 打进桌面端。二进制能被反编译，
          这等于把自家的授权服务器钥匙公开。公开客户端不允许使用 Client Credentials。
        </p>
      </DocsSection>

      <DocsSection title="公开客户端：X-Client-ID 不是密钥">
        <p>
          <code className="font-mono text-[12.5px]">X-Client-ID</code> 只是让服务端知道「这是哪个产品的哪个客户端」，
          用来做限流、统计和作用域校验。它出现在每个请求里，也必然出现在二进制里。
        </p>
        <CodeBlock
          language="http"
          filename="请求头"
          code={`POST /api/v1/activation-challenges HTTP/1.1
Host: <LICENSE_SANDBOX_DOMAIN>
Content-Type: application/json
X-Client-ID: <your-client-id>
X-SDK-Version: python-example/1.0.0
X-Client-Platform: windows`}
        />
        <p>真正的身份证明是设备私钥签名：私钥在客户端本地生成并持久化，服务端只存公钥。</p>
      </DocsSection>

      <DocsSection title="规范化消息：差一个换行就验签失败">
        <p>签名对象是服务端给的字符串，v1 格式如下（每行一个 LF，末尾不加换行）：</p>
        <CodeBlock
          language="text"
          filename="canonical_message (v1)"
          code={`LICENSE-ACTIVATION-CHALLENGE-V1
{challenge_id}
{nonce}
{product_id}
{device_instance_id}
{expires_at}`}
        />
        <p>
          直接签服务端返回的 <code className="font-mono text-[12.5px]">canonical_message</code> 字段最安全。
          只有当你自己拼字符串时才需要小心：字段顺序、换行符（LF 不是 CRLF）、末尾不能多换行，
          任何一处不同都会得到 401 CLIENT_AUTH_FAILED，而且错误信息不会告诉你是哪一行错了。
        </p>
        <CodeBlock
          language="python"
          filename="用服务端给的字符串签名（推荐）"
          code={`signature = base64.urlsafe_b64encode(
    private_key.sign(challenge["canonical_message"].encode())
).decode().rstrip("=")`}
        />
      </DocsSection>

      <DocsSection title="服务端之间：private_key_jwt">
        <p>
          网站后端、网关这类可信服务端调用 <code className="font-mono text-[12.5px]">POST /server/licenses/check</code> 时，
          用 JWT 断言证明身份，而不是共享密钥：
        </p>
        <CodeBlock
          language="python"
          filename="构造 client_assertion"
          code={`import jwt, time, uuid   # pip install pyjwt cryptography

now = int(time.time())
assertion = jwt.encode(
    {
        "iss": CLIENT_ID,              # 必须是凭证的 client_id
        "sub": CLIENT_ID,
        "aud": "license-api",          # 固定值，见后台凭证详情
        "iat": now,
        "exp": now + 120,              # 有效期不得超过 300 秒
        "jti": str(uuid.uuid4()),      # 一次性，重复使用会被拒
    },
    PRIVATE_KEY_PEM,                   # Ed25519 私钥，只在服务器上
    algorithm="EdDSA",
    headers={"kid": CREDENTIAL_ID},    # 告诉服务端用哪把公钥验签
)`}
        />
        <p>
          然后把它放在请求体里，或者直接用 Bearer 传整段 JWT：
        </p>
        <CodeBlock
          language="json"
          filename="放在请求体"
          code={`{
  "client_assertion": "<jwt>",
  "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  "identity": { "provider": "wechat_mini_program", "subject_token": "openid-xxx" },
  "required_features": ["basic_export"]
}`}
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>有效期超过 300 秒会被拒（防重放窗口过长）。</li>
          <li>
            <code className="font-mono text-[12.5px]">jti</code> 只用一次；重复提交返回 401 并提示「疑似重放」。
          </li>
          <li>
            <code className="font-mono text-[12.5px]">kid</code> 是凭证 ID，不是密钥 ID —— 公钥由服务端按凭证查。
          </li>
        </ul>
      </DocsSection>

      <DocsSection title="Authorization: Bearer">
        <p>
          激活 / 心跳拿到的 <code className="font-mono text-[12.5px]">access_token</code> 放在这里。
          三个规则：只放 header、不放 URL、不放日志。
        </p>
        <CodeBlock
          language="http"
          filename="调用需要令牌的端点"
          code={`GET /api/v1/activations/{activation_id}/entitlements HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIs...
X-Client-ID: <your-client-id>`}
        />
        <p>
          令牌和激活记录绑定：把 A 激活的令牌拿去查 B 的权限会得到 403，
          不是 401 —— 身份是真的，只是没有权限看这条记录。
        </p>
      </DocsSection>

      <DocsSection title="常见认证失败">
        <ParamsTable
          rows={[
            { name: "401 CLIENT_AUTH_FAILED", type: "缺失/无效", required: false, description: "X-Client-ID 不存在、已停用，或签名验不过" },
            { name: "401 + 疑似重放", type: "断言重复", required: false, description: "同一个 jti 被用了第二次" },
            { name: "403 PRODUCT_DISABLED", type: "产品停用", required: false, description: "凭证没问题，但产品被关掉了" },
            { name: "403 FORBIDDEN", type: "越权访问", required: false, description: "令牌不属于该 activation_id" },
          ]}
        />
      </DocsSection>
    </>
  );
}
