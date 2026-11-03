import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "限流" };

const LIMITS = [
  { scope: "POST /activation-challenges", limit: "30 次 / 分", note: "激活入口，防刷挑战" },
  { scope: "POST /activations", limit: "10 次 / 分", note: "最严格的一档，防止暴力试授权码" },
  { scope: "POST /activations/heartbeat", limit: "60 次 / 分", note: "正常客户端每分钟最多 4 次，余量充足" },
  { scope: "POST /activations/deactivate", limit: "10 次 / 分", note: "解绑不频繁" },
  { scope: "GET /activations/{id}/entitlements", limit: "120 次 / 分", note: "读接口，额度高" },
  { scope: "POST /licenses/validate", limit: "30 次 / 分", note: "激活页即时校验" },
  { scope: "POST /server/licenses/check", limit: "120 次 / 分", note: "服务端调用，按产品维度" },
];

export default function RateLimitsPage() {
  return (
    <>
      <DocsHeader
        title="限流"
        description="固定窗口计数，按「产品 + 组织 + IP」三层同时统计。任何一层超限都会拒绝。"
      />

      <DocsSection title="为什么按三层计数">
        <p>
          只按 IP 计数，一个 NAT 后面的整个办公室会互相影响；只按产品计数，单个 IP 就能把全产品额度打满。
          三层同时算：产品维度防单产品被打爆，组织维度防单租户影响其他租户，IP 维度防单机刷接口。
        </p>
      </DocsSection>

      <DocsSection title="端点配额">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-3 py-1.5 font-medium">端点</th>
                <th className="px-3 py-1.5 font-medium">额度</th>
                <th className="px-3 py-1.5 font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {LIMITS.map((row) => (
                <tr key={row.scope} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-1.5 font-mono text-[12px]">{row.scope}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{row.limit}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[13px]">窗口固定 60 秒。未列出的端点走默认 120 次 / 分。</p>
      </DocsSection>

      <DocsSection title="响应头">
        <CodeBlock
          language="http"
          filename="每个公开响应都带"
          code={`RateLimit-Limit: 10
RateLimit-Remaining: 7
RateLimit-Reset: 42`}
        />
        <p>
          <code className="font-mono text-[12.5px]">RateLimit-Reset</code> 是距离窗口重置的秒数，
          不是时间戳。用它安排下一次请求最准。
        </p>
      </DocsSection>

      <DocsSection title="429 长什么样">
        <CodeBlock
          language="json"
          filename="429 Too Many Requests"
          code={`{
  "ok": false,
  "code": "RATE_LIMITED",
  "message": "请求过于频繁，请稍后重试",
  "request_id": "req_01HX...",
  "server_time": "2026-11-02T09:00:00.000Z"
}`}
        />
        <p>响应头同时带 <code className="font-mono text-[12.5px]">Retry-After</code>，单位秒。</p>
      </DocsSection>

      <DocsSection title="正确做法与错误做法">
        <CodeBlock
          language="python"
          filename="退避重试"
          code={`import random, time, urllib.error

def call_with_retry(fn, attempts=3):
    for i in range(attempts):
        try:
            return fn()
        except urllib.error.HTTPError as error:
            if error.code == 429 and i < attempts - 1:
                wait = int(error.headers.get("Retry-After", "1"))
                # 抖动：避免所有客户端在同一毫秒重连
                time.sleep(wait + random.uniform(0, 0.5))
                continue
            raise`}
        />
        <p className="text-[13px]">
          错误做法：收到 429 立刻原样重试（会让窗口内的计数继续上涨）；
          或者每个进程各自计数（多实例下必然误判，服务端才是唯一权威）。
        </p>
      </DocsSection>
    </>
  );
}
