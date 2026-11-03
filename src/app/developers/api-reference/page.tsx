import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection, EndpointLine, ParamsTable } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";
import { endpointsFromSpec } from "@/lib/developers/llms-generator";

export const metadata: Metadata = { title: "API 参考" };

const ENVELOPE = `{
  "ok": true,
  "code": "OK",
  "message": "成功",
  "request_id": "req_01HX...",
  "server_time": "2026-11-02T09:00:00.000Z",
  "data": { }
}`;

export default function ApiReferencePage() {
  // 数量从 OpenAPI 契约现算：手写「7 个端点」在加了 3 个端点之后就成了错误信息，
  // 而这类数字没人会记得改。
  const endpointCount = endpointsFromSpec().length;

  return (
    <>
      <DocsHeader
        badge={`${endpointCount} 个端点`}
        title="API 参考"
        description="全部公开端点。响应统一包在 data 里，错误统一用 code 判断。完整机器可读定义见 /developers/openapi.yaml。"
      />

      <DocsSection title="响应信封">
        <CodeBlock language="json" filename="成功" code={ENVELOPE} />
        <p>
          <code className="font-mono text-[12.5px]">request_id</code> 是排障的唯一线索，
          <code className="font-mono text-[12.5px]"> server_time</code> 是服务端时间 —— 客户端不要依赖本地时钟判断过期。
        </p>
      </DocsSection>

      <DocsSection title="请求头速查">
        <ParamsTable
          rows={[
            { name: "Content-Type", type: "header", required: true, description: "固定 application/json" },
            { name: "X-Client-ID", type: "header", required: true, description: "公开客户端标识（所有 /api/v1 端点）" },
            { name: "Authorization", type: "header", required: false, description: "Bearer access_token；服务端断言也可放这里" },
            { name: "Idempotency-Key", type: "header", required: false, description: "激活必填；重试时复用同一个值" },
            { name: "X-SDK-Version", type: "header", required: false, description: "如 python-example/1.0.0，便于排查" },
            { name: "X-Client-Platform", type: "header", required: false, description: "windows / macos / linux / chrome / mini-program" },
          ]}
        />
      </DocsSection>

      <div className="mt-10 space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">端点</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li><a href="#challenge" className="text-primary hover:underline">POST /activation-challenges</a></li>
          <li><a href="#activate" className="text-primary hover:underline">POST /activations</a></li>
          <li><a href="#heartbeat" className="text-primary hover:underline">POST /activations/heartbeat</a></li>
          <li><a href="#deactivate" className="text-primary hover:underline">POST /activations/deactivate</a></li>
          <li><a href="#entitlements" className="text-primary hover:underline">GET /activations/&#123;activation_id&#125;/entitlements</a></li>
          <li><a href="#validate" className="text-primary hover:underline">POST /licenses/validate</a></li>
          <li><a href="#server-check" className="text-primary hover:underline">POST /server/licenses/check</a></li>
        </ul>
      </div>

      <DocsSection title="1. 创建设备挑战" id="challenge">
        <EndpointLine method="POST" path="/api/v1/activation-challenges" />
        <p>激活的第一步。返回一次性 nonce 与待签名消息，5 分钟有效。</p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "product_id", type: "uuid", required: true, description: "目标产品" },
            { name: "device.device_instance_id", type: "string", required: true, description: "客户端生成的稳定设备标识" },
            { name: "device.platform", type: "string", required: true, description: "windows / macos / linux / chrome / mini-program" },
            { name: "device.device_name", type: "string", required: false, description: "展示用名称，会出现在后台设备列表" },
            { name: "device.public_key", type: "base64url", required: true, description: "Ed25519 SPKI 公钥，无填充" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "challenge_id": "018f2a...",
  "nonce": "q9Xa...",
  "expires_at": "2026-11-02T09:05:00.000Z",
  "signing_algorithm": "Ed25519",
  "canonical_version": "v1",
  "canonical_message": "LICENSE-ACTIVATION-CHALLENGE-V1\\n018f2a...\\nq9Xa...\\n..."
}`}
        />
        <p className="text-[13px]">
          错误：400 INVALID_REQUEST（公钥格式不对）、401 CLIENT_AUTH_FAILED、403 PRODUCT_DISABLED、429 RATE_LIMITED。
        </p>
      </DocsSection>

      <DocsSection title="2. 激活授权" id="activate">
        <EndpointLine method="POST" path="/api/v1/activations" />
        <p>验签、占用设备名额、签发令牌。必须带 Idempotency-Key，网络抖动重试不会多占一个名额。</p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "product_id", type: "uuid", required: true, description: "必须与 X-Client-ID 所属产品一致，否则 422 PRODUCT_MISMATCH" },
            { name: "license_key", type: "string", required: true, description: "授权码，大小写与连字符不敏感" },
            { name: "challenge_id", type: "string", required: true, description: "上一步拿到的挑战" },
            { name: "device.signature", type: "base64url", required: true, description: "对 canonical_message 的 Ed25519 签名" },
            { name: "client.app_version", type: "string", required: false, description: "你的软件版本，用于统计" },
            { name: "client.sdk_version", type: "string", required: false, description: "SDK 版本" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="201 Created · data"
          code={`{
  "activation_id": "7f3c...",
  "license_id": "b21e...",
  "product_id": "db31...",
  "effective_status": "active",
  "starts_at": "2026-11-02T09:00:00.000Z",
  "expires_at": "2027-11-02T09:00:00.000Z",
  "duration": { "unit": "month", "value": 12, "label": "一年（12 个自然月）" },
  "device_limit": { "max": 3, "active": 1 },
  "activation_limit": { "max": 5, "used": 1 },
  "entitlements": { "basic_export": true, "max_batch_size": 100 },
  "entitlements_version": 1,
  "access_token": "eyJhbGciOiJFZERTQSIs...",
  "access_token_expires_at": "2026-11-02T10:00:00.000Z",
  "refresh_token": "rt_9xQ...",
  "refresh_token_expires_at": "2026-12-02T09:00:00.000Z",
  "heartbeat_interval_seconds": 900
}`}
        />
        <p className="text-[13px]">
          错误：400、401 CLIENT_AUTH_FAILED、409 LICENSE_ALREADY_BOUND / DEVICE_LIMIT_EXCEEDED /
          ACTIVATION_LIMIT_REACHED / IDEMPOTENCY_CONFLICT、410 LICENSE_EXPIRED / ACTIVATION_WINDOW_EXPIRED、
          422 LICENSE_INVALID / PRODUCT_MISMATCH、423 LICENSE_SUSPENDED、429。
        </p>
        <p className="text-[13px]">
          <code className="font-mono text-[12.5px]">refresh_token</code> 只在这次响应里出现一次，服务端只存哈希。
          丢了只能重新激活。
        </p>
      </DocsSection>

      <DocsSection title="3. 心跳" id="heartbeat">
        <EndpointLine method="POST" path="/api/v1/activations/heartbeat" />
        <p>每 <code className="font-mono text-[12.5px]">next_heartbeat_seconds</code> 调一次。同时完成三件事：续期访问令牌、轮换刷新令牌、拉取最新权限。</p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "activation_id", type: "uuid", required: true, description: "激活记录 ID" },
            { name: "refresh_token", type: "string", required: true, description: "上一次拿到的 refresh_token" },
            { name: "device_proof", type: "base64url", required: false, description: "设备私钥对心跳体的签名（可选加固）" },
            { name: "client.app_version", type: "string", required: false, description: "同上" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "effective_status": "active",
  "expires_at": "2027-11-02T09:00:00.000Z",
  "entitlements_version": 2,
  "entitlements": { "basic_export": true, "max_batch_size": 200 },
  "access_token": "eyJhbGciOiJFZERTQSIs...",
  "access_token_expires_at": "2026-11-02T10:15:00.000Z",
  "refresh_token": "rt_NEW...",
  "refresh_token_expires_at": "2026-12-02T09:15:00.000Z",
  "next_heartbeat_seconds": 900
}`}
        />
        <p className="text-[13px]">
          旧 refresh_token 被再次使用会触发防重放：整条会话作废，并写一条 activation.blocked 安全事件。
          所以收到新值后要先落盘。
        </p>
        <p className="text-[13px]">
          错误：401（令牌无效）、410 LICENSE_EXPIRED、423 LICENSE_SUSPENDED、429。心跳返回 423 时应当立刻停止功能，而不是继续重试。
        </p>
      </DocsSection>

      <DocsSection title="4. 解绑设备" id="deactivate">
        <EndpointLine method="POST" path="/api/v1/activations/deactivate" />
        <p>释放一台设备的名额。重复调用是幂等的，第二次会返回 device_slot_released: false。</p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "activation_id", type: "uuid", required: true, description: "要解绑的激活记录" },
            { name: "refresh_token", type: "string", required: false, description: "不带则需 Authorization: Bearer" },
            { name: "reason", type: "string", required: false, description: "写进审计与事件，建议填「用户主动解绑」这类短语" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "activation_id": "7f3c...",
  "status": "released",
  "device_slot_released": true,
  "released": true,
  "activation_count": 1
}`}
        />
        <p className="text-[13px]">
          注意 <code className="font-mono text-[12.5px]">activation_count</code> 不会减少 —— 解绑只腾名额，不返还激活次数。
        </p>
      </DocsSection>

      <DocsSection title="5. 查询权限" id="entitlements">
        <EndpointLine method="GET" path="/api/v1/activations/{activation_id}/entitlements" />
        <p>需要单独确认权限时用（例如设置页展示「你的套餐包含什么」）。需要 Authorization: Bearer。</p>
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "license_id": "b21e...",
  "activation_id": "7f3c...",
  "effective_status": "active",
  "expires_at": "2027-11-02T09:00:00.000Z",
  "entitlements_version": 2,
  "entitlements": { "basic_export": true },
  "features": [
    { "code": "basic_export", "name": "基础导出", "value_type": "boolean", "value": true }
  ]
}`}
        />
        <p className="text-[13px]">错误：401、403（令牌不属于该激活）、410、423。</p>
      </DocsSection>

      <DocsSection title="6. 授权码预检查" id="validate">
        <EndpointLine method="POST" path="/api/v1/licenses/validate" />
        <p>激活前先问「这个码能不能用」，用于激活界面即时反馈。不消耗挑战，也不占设备名额。</p>
        <CodeBlock
          language="json"
          filename="请求"
          code={`{ "product_id": "db31...", "license_key": "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" }`}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "valid": true,
  "effective_status": "active",
  "expires_at": "2027-11-02T09:00:00.000Z",
  "duration": { "unit": "month", "value": 12, "label": "一年（12 个自然月）" },
  "device_limit": { "max": 3, "active": 1 },
  "activation_limit": { "max": 5, "used": 1 }
}`}
        />
        <p className="text-[13px]">
          为了不泄露「某个授权码是否存在」，无效码和不存在码返回同一个 <code className="font-mono text-[12.5px]">valid: false</code> 结构。
        </p>
      </DocsSection>

      <DocsSection title="7. 服务端授权检查" id="server-check">
        <EndpointLine method="POST" path="/api/v1/server/licenses/check" />
        <p>
          给网站后端 / 小程序后端用。认证是 private_key_jwt 断言，不是 X-Client-ID。
          按「用户身份」查授权，而不是按授权码。
        </p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "client_assertion", type: "jwt", required: true, description: "EdDSA 签名断言，也可放 Authorization: Bearer" },
            { name: "identity.provider", type: "enum", required: true, description: "wechat_mini_program / google / microsoft / email / phone / custom" },
            { name: "identity.subject_token", type: "string", required: true, description: "你后端已验证过的用户标识；服务端只存它的 SHA-256" },
            { name: "required_features", type: "string[]", required: false, description: "需要确认的功能码列表" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "authorized": false,
  "effective_status": "active",
  "license_id": "b21e...",
  "expires_at": "2027-11-02T09:00:00.000Z",
  "entitlements_version": 1,
  "entitlements": { "seat_limit": 15, "sla_report": true },
  "missing_features": ["export_pdf"]
}`}
        />
        <p className="text-[13px]">
          <code className="font-mono text-[12.5px]">authorized</code> 为 false 但 <code className="font-mono text-[12.5px]">effective_status</code> 为 active，
          说明授权有效但这个用户缺某个功能 —— 这种情况应该降级而不是拦截登录。
        </p>
      </DocsSection>

      <DocsSection title="8. 查询激活状态" id="activation-status">
        <EndpointLine method="GET" path="/api/v1/activations/{activation_id}" />
        <p>
          心跳拿不到响应时用它确认「是网络断了，还是授权真的不能用了」。
          <strong>授权不可用时这里仍然返回 200</strong>，靠 <code className="font-mono text-[12.5px]">usable</code> 与{" "}
          <code className="font-mono text-[12.5px]">status_reason</code> 判断 ——
          这样调用方能区分「该重试」和「该提示用户」。
        </p>
        <ParamsTable
          caption="路径参数"
          rows={[
            { name: "activation_id", type: "uuid", required: true, description: "必须与令牌里的 aid 一致，否则 403" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "activation_id": "1f809ad7-...",
  "license_id": "b5729f11-...",
  "product_code": "fluxpanel-desktop",
  "status": "active",
  "effective_status": "suspended",
  "usable": false,
  "status_reason": "授权已被管理员暂停",
  "expires_at": "2026-12-02T14:24:00.000Z",
  "device_limit": { "max": 1, "active": 1 },
  "entitlements_version": 2,
  "offline": { "allowed": true, "grace_seconds": 604800 }
}`}
        />
      </DocsSection>

      <DocsSection title="9. 离线授权文件" id="offline-grant">
        <EndpointLine method="POST" path="/api/v1/offline-grants" />
        <p>
          给已激活的设备签发可离线校验的授权文件。签名覆盖{" "}
          <code className="font-mono text-[12.5px]">canonicalJson(grant)</code>，
          客户端要缓存 <code className="font-mono text-[12.5px]">canonical_payload</code> 原文和公钥，
          断网时用它验签 —— 不要自己重新序列化，键序变了签名就不对。
        </p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "activation_id", type: "uuid", required: true, description: "必须是当前令牌绑定的那条激活" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="201 Created · data"
          code={`{
  "grant": {
    "format": "license-offline-v1",
    "kid": "sk_20261102_a1b2c3d4",
    "serial": "og_20261102143000_9f3c1d2e",
    "device_key_thumbprint": "sha256:...",
    "issued_at": "2026-11-02T06:30:00.000Z",
    "valid_until": "2026-11-09T06:30:00.000Z",
    "entitlements_version": 2,
    "entitlements": { "advanced_settings": false }
  },
  "signature": "...",
  "algorithm": "EdDSA",
  "signing_key": { "kid": "sk_20261102_a1b2c3d4", "public_key": "...", "raw_public_key": "..." },
  "canonical_payload": "{...}",
  "expires_in_seconds": 604800
}`}
        />
        <p className="text-[13px]">
          <code className="font-mono text-[12.5px]">valid_until</code> 取{" "}
          <code className="font-mono text-[12.5px]">min(now + grace_seconds, 授权到期时间)</code>，
          离线文件永远不会比授权本身活得更久。
        </p>
      </DocsSection>

      <DocsSection title="10. 服务端令牌交换" id="oauth-token">
        <EndpointLine method="POST" path="/api/v1/oauth/token" />
        <p>
          服务端到服务端场景：用 <code className="font-mono text-[12.5px]">private_key_jwt</code> 断言
          换一个短期 Bearer 令牌，后续请求带令牌即可，不必每次都重签断言。
          <strong>不支持 client_secret</strong>：共享密钥一旦泄漏无法区分调用方，也无法轮换。
        </p>
        <ParamsTable
          caption="请求体"
          rows={[
            { name: "grant_type", type: "enum", required: true, description: "只能是 private_key_jwt" },
            { name: "client_assertion", type: "jwt", required: false, description: "也可放 Authorization: Bearer" },
            { name: "scope", type: "string", required: false, description: "空格分隔；只能收窄凭证自身的权限" },
          ]}
        />
        <CodeBlock
          language="json"
          filename="200 OK · data"
          code={`{
  "access_token": "eyJhbGciOiJFZERTQSIsImtpZCI6InNrXzIwMjYxMTAyIn0...",
  "token_type": "Bearer",
  "expires_in": 900,
  "expires_at": "2026-11-02T06:45:00.000Z",
  "scope": "server:check entitlements:read",
  "signing_key": { "kid": "sk_20261102_a1b2c3d4", "algorithm": "EdDSA" }
}`}
        />
      </DocsSection>
    </>
  );
}
