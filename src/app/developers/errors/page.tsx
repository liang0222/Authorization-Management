import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";
import { ERROR_STATUS } from "@/lib/http/api";

export const metadata: Metadata = { title: "错误码" };

/**
 * 每个错误码的「人话解释」与「该怎么做」。
 *
 * 清单本身来自 `ERROR_STATUS`（`src/lib/http/api.ts`）——那里才是服务端真正会返回的码，
 * 这里只补文案。类型写成 `Record<keyof typeof ERROR_STATUS, …>`：服务端加了码而这里没补，
 * 编译期就会报缺键，而不是让用户看到一张漏行的表。
 */
const ERROR_GUIDANCE: Record<
  keyof typeof ERROR_STATUS,
  { meaning: string; action: string }
> = {
  INVALID_REQUEST: { meaning: "请求体字段缺失或格式不对", action: "按提示修字段；不要重试" },
  CLIENT_AUTH_FAILED: {
    meaning: "X-Client-ID 无效、设备签名验不过、令牌过期",
    action: "检查密钥与签名原文；令牌过期则重新激活或心跳",
  },
  MFA_REQUIRED: { meaning: "管理后台登录需要二次验证", action: "只在后台出现，SDK 不会遇到" },
  CSRF_FAILED: {
    meaning: "管理后台表单缺少或带错了 CSRF 令牌",
    action: "只在后台出现；刷新页面重试，SDK 不会遇到",
  },
  CONFLICT: { meaning: "并发写入冲突", action: "重新读取最新数据后再提交" },
  FORBIDDEN: { meaning: "身份有效但无权访问该资源", action: "检查令牌是否属于该 activation" },
  PRODUCT_DISABLED: {
    meaning: "产品被停用，该产品所有调用一起失败",
    action: "联系管理员；不要重试",
  },
  RESOURCE_NOT_FOUND: { meaning: "激活记录等资源不存在", action: "确认 ID 与产品一致" },
  LICENSE_ALREADY_BOUND: {
    meaning: "同一授权码已绑定到其他设备且不允许新设备",
    action: "先解绑旧设备，或提高设备上限",
  },
  DEVICE_LIMIT_EXCEEDED: { meaning: "活跃设备数已达上限", action: "引导用户解绑不用的设备" },
  ACTIVATION_LIMIT_REACHED: { meaning: "累计激活次数已用完", action: "只有管理员能重置次数" },
  IDEMPOTENCY_CONFLICT: {
    meaning: "同一个 Idempotency-Key 被用于不同请求体",
    action: "换一个 key；不要复用",
  },
  LICENSE_EXPIRED: { meaning: "授权已过期", action: "提示续费；停止功能" },
  ACTIVATION_WINDOW_EXPIRED: {
    meaning: "超过激活截止时间仍未首次激活",
    action: "需要管理员重新签发",
  },
  LICENSE_INVALID: {
    meaning: "授权码不存在或被作废",
    action: "提示用户核对；不要暴露「不存在」细节",
  },
  PRODUCT_MISMATCH: {
    meaning: "授权码属于别的产品",
    action: "检查 product_id 与客户端是否配对",
  },
  LICENSE_SUSPENDED: {
    meaning: "授权被暂停",
    action: "立即停止功能；暂停期间重试无意义",
  },
  DEVICE_BLOCKED: { meaning: "该设备被拉黑", action: "停止使用；联系管理员" },
  RATE_LIMITED: { meaning: "超过配额", action: "按 Retry-After 退避；带抖动的指数重试" },
  INTERNAL_ERROR: { meaning: "服务端异常", action: "可重试；带上 request_id 反馈" },
  LICENSE_SERVICE_UNAVAILABLE: {
    meaning: "依赖不可用（维护中）",
    action: "可重试；建议进入离线授权模式",
  },
};

/** 状态码由服务端定，这里不再抄一遍；表格按状态码分组排序更好读。 */
const ERRORS = (Object.keys(ERROR_STATUS) as Array<keyof typeof ERROR_STATUS>)
  .map((code) => ({
    code,
    status: ERROR_STATUS[code],
    ...ERROR_GUIDANCE[code],
  }))
  .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
export default function ErrorsPage() {
  return (
    <>
      <DocsHeader
        title="错误码"
        description="按 code 分支，不要按 message 或 HTTP 状态码分支。同一个 409 可能是四种完全不同的处理方式。"
      />

      <DocsSection title="错误信封">
        <CodeBlock
          language="json"
          filename="401"
          code={`{
  "ok": false,
  "code": "CLIENT_AUTH_FAILED",
  "message": "设备签名校验失败",
  "request_id": "req_01HX...",
  "server_time": "2026-11-02T09:00:00.000Z"
}`}
        />
        <p className="text-[13px]">
          <code className="font-mono text-[12.5px]">message</code> 是给人看的，措辞随时可能调整；
          <code className="font-mono text-[12.5px]"> code</code> 是契约。
        </p>
      </DocsSection>

      <DocsSection title="完整列表">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-3 py-1.5 font-medium">code</th>
                <th className="px-3 py-1.5 font-medium">HTTP</th>
                <th className="px-3 py-1.5 font-medium">含义</th>
                <th className="px-3 py-1.5 font-medium">怎么处理</th>
              </tr>
            </thead>
            <tbody>
              {ERRORS.map((row) => (
                <tr key={row.code} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-1.5 font-mono text-[12px] whitespace-nowrap">{row.code}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{row.status}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{row.meaning}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocsSection>

      <DocsSection title="哪些该重试，哪些不该">
        <CodeBlock
          language="text"
          filename="重试策略"
          code={`应该重试   网络错误、408、429（按 Retry-After）、500、503
不要重试   400、401、403、410、422、423
            这些重试一百次结果一样，只会烧配额`}
        />
        <p>
          重试要有上限与退避：建议最多 3 次，指数退避 + 随机抖动，避免所有客户端在同一秒重连。
          401 是例外中的例外 —— 如果是 access_token 过期，可以先用 refresh_token 换新令牌再重试一次，
          但只允许一次，防止刷新令牌也被判重放。
        </p>
      </DocsSection>

      <DocsSection title="排障三步">
        <ol className="list-decimal space-y-1 pl-5">
          <li>记下 request_id，交给管理员在「验证日志」里查这条请求的完整记录。</li>
          <li>确认 code，而不是盯着 message 猜。</li>
          <li>
            本地复现时先看 <code className="font-mono text-[12.5px]">server_time</code> 与本地时钟差多少 ——
            设备时间偏差过大会导致令牌「刚拿到就过期」。
          </li>
        </ol>
      </DocsSection>
    </>
  );
}
