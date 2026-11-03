import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection, ParamsTable } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";
import { WEBHOOK_EVENT_TYPES } from "@/lib/services/webhook-events";

export const metadata: Metadata = { title: "Webhook" };

/**
 * 事件说明文案。清单本身来自 `WEBHOOK_EVENT_TYPES`，这里只补「这个事件什么时候发」。
 *
 * 用 `Record<WebhookEventType, string>` 而不是普通对象：新增事件却忘了写说明时，
 * 编译期就会报缺键，而不是等用户看到一张空说明的表格。
 */
const EVENT_DESCRIPTIONS: Record<(typeof WEBHOOK_EVENT_TYPES)[number], string> = {
  "license.activated": "首次激活成功",
  "license.renewed": "续费成功，到期时间已顺延",
  "license.suspended": "被管理员暂停",
  "license.resumed": "暂停后恢复",
  "license.revoked": "被吊销（终态）",
  "license.expired": "自然过期",
  "activation.created": "新设备激活",
  "activation.released": "设备解绑",
  "activation.blocked": "设备被封禁或疑似 refresh_token 重放",
  "entitlements.updated": "权限位发生变化，客户端应在下次心跳刷新",
};

export default function WebhooksPage() {
  return (
    <>
      <DocsHeader
        title="Webhook"
        description="授权状态变了就推给你，不用轮询。所有请求都带 HMAC-SHA256 签名，必须验签后再信任内容。"
      />

      <DocsSection title="事件类型">
        <ParamsTable
          caption={`${WEBHOOK_EVENT_TYPES.length} 个事件`}
          rows={WEBHOOK_EVENT_TYPES.map((event) => ({
            name: event,
            type: event.split(".")[0] === "license" ? "授权" : event.split(".")[0] === "activation" ? "激活" : "权限",
            required: false,
            description: EVENT_DESCRIPTIONS[event],
          }))}
        />
      </DocsSection>

      <DocsSection title="请求长什么样">
        <CodeBlock
          language="http"
          filename="POST 到你的回调地址"
          code={`POST /your/webhook HTTP/1.1
Content-Type: application/json
User-Agent: ziming-license-webhook/1.5
X-License-Event-Id: evt_3f8a1b2c
X-License-Event-Type: license.suspended
X-License-Timestamp: 1793610189
X-License-Signature: v1=83a2a18f548cff66...`}
        />
        <CodeBlock
          language="json"
          filename="请求体"
          code={`{
  "event_id": "evt_3f8a1b2c",
  "event_type": "license.suspended",
  "occurred_at": "2026-11-02T09:00:00.000Z",
  "api_version": "v1",
  "data": {
    "license_id": "b21e...",
    "product_id": "db31...",
    "reason": "用户申请退款"
  }
}`}
        />
      </DocsSection>

      <DocsSection title="验签（必做）">
        <p>
          签名原文是 <code className="font-mono text-[12.5px]">{"{timestamp}.{raw_body}"}</code>，
          注意是<strong className="text-foreground">原始请求体字节</strong>，不是解析后再序列化的结果。
        </p>
        <CodeBlock
          language="python"
          filename="Flask 验签示例"
          code={`import hmac, hashlib, time
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = "whsec_..."          # 从后台创建端点时拿到的，只显示一次

@app.post("/your/webhook")
def receive():
    timestamp = request.headers.get("X-License-Timestamp", "")
    signature = request.headers.get("X-License-Signature", "")
    raw = request.get_data()   # 必须用原始字节

    # 1. 时间窗：防止旧请求被重放
    if abs(time.time() - int(timestamp or 0)) > 300:
        abort(400, "timestamp out of window")

    # 2. 恒时比较，避免通过响应时间猜签名
    expected = "v1=" + hmac.new(
        SECRET.encode(), f"{timestamp}.".encode() + raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        abort(401, "bad signature")

    # 3. 按 event_id 去重（投递可能重试）
    event = request.get_json()
    if seen(event["event_id"]):
        return "", 200

    handle(event)
    return "", 200`}
        />
        <p className="text-[13px]">
          三步缺一不可：不验时间窗，攻击者可以把抓到的请求无限重放；不用恒时比较，
          理论上可以逐字节爆破签名；不按 event_id 去重，重试会导致重复发货。
        </p>
      </DocsSection>

      <DocsSection title="重试与死信">
        <CodeBlock
          language="text"
          filename="退避节奏"
          code={`第 1 次失败  30 秒后重试
第 2 次      2 分钟后
第 3 次      8 分钟后
第 4 次      32 分钟后
第 5 次      2 小时后
第 6 次      仍失败 → 标记 dead，保留记录等人工重放`}
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>单次请求超时 10 秒，超时算失败。</li>
          <li>只有 5xx 与 429 会重试；4xx 一次就判死 —— 你的代码有问题，重试没用。</li>
          <li>不跟随重定向：回调地址被劫持成 30x 时不会把数据发到未验证主机。</li>
          <li>「dead」不是丢失，后台可以一键重放，重放后立刻投递并显示结果。</li>
        </ul>
      </DocsSection>

      <DocsSection title="回调地址要求">
        <ul className="list-disc space-y-1 pl-5">
          <li>必须 https。开发环境允许 http://localhost 与 http://127.0.0.1。</li>
          <li>禁止填内网地址、云元数据地址（169.254.169.254）—— SSRF 防护在服务端做。</li>
          <li>请在 10 秒内返回 2xx，先落库再处理，不要把耗时任务放在请求里做。</li>
        </ul>
      </DocsSection>

      <DocsSection title="轮换密钥">
        <p>
          后台「Webhook」页可以对端点执行「轮换密钥」。轮换后旧密钥<strong className="text-foreground">立即失效</strong>，
          没有并行有效期 —— 这是有意的，避免「两个密钥都能签」的窗口被利用。
        </p>
        <p className="text-[13px]">
          因此轮换要在你的服务端支持双密钥校验之后再点：先把新密钥配到接收端并允许新旧都通过，
          再在后台轮换，最后移除旧密钥。
        </p>
      </DocsSection>
    </>
  );
}
