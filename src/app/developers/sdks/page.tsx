import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "SDK 与示例" };

export default function SdksPage() {
  return (
    <>
      <DocsHeader
        badge="示例优先"
        title="SDK 与示例"
        description="当前发布状态：只提供可运行的 HTTP 示例，尚未发布到 PyPI / Packagist / npm。没发布的包不标 Stable —— 装了但跑不起来比没有更糟。"
      />

      <DocsSection title="发布状态">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-border bg-muted/30">
              <tr>
                <th className="px-3 py-1.5 font-medium">语言</th>
                <th className="px-3 py-1.5 font-medium">状态</th>
                <th className="px-3 py-1.5 font-medium">获取方式</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/60">
                <td className="px-3 py-1.5">Python 3.9+</td>
                <td className="px-3 py-1.5"><span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[12px] text-emerald-700 dark:text-emerald-400">Example · 已实测</span></td>
                <td className="px-3 py-1.5 font-mono text-[12px]">sdk-examples/python/</td>
              </tr>
              <tr className="border-b border-border/60">
                <td className="px-3 py-1.5">Node.js 18+</td>
                <td className="px-3 py-1.5"><span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[12px] text-emerald-700 dark:text-emerald-400">Example · 已实测</span></td>
                <td className="px-3 py-1.5 font-mono text-[12px]">sdk-examples/node/</td>
              </tr>
              <tr className="border-b border-border/60">
                <td className="px-3 py-1.5">PHP 8.1+</td>
                <td className="px-3 py-1.5"><span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[12px] text-emerald-700 dark:text-emerald-400">Example · 已实测</span></td>
                <td className="px-3 py-1.5 font-mono text-[12px]">sdk-examples/php/</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5">Go / Java / C#</td>
                <td className="px-3 py-1.5"><span className="rounded bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground">Preview · 未发布</span></td>
                <td className="px-3 py-1.5 text-muted-foreground">参考 Python 示例自行封装</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[13px]">
          「已实测」指该脚本在本项目的 Sandbox 环境真实跑通了激活与错误分支，不是「代码看起来对」。
        </p>
      </DocsSection>

      <DocsSection title="SDK 该做什么，不该做什么">
        <CodeBlock
          language="text"
          filename="职责边界"
          code={`应该封装   序列化、X-Client-ID、超时、重试退避、幂等键、错误码 → 异常类、日志脱敏
不该封装   业务判断（什么功能算 VIP）、UI 提示文案、授权码存储策略
不该写死   生产域名（默认 Sandbox）、超时时间（要可配）、TLS 校验（永远开启）`}
        />
      </DocsSection>

      <DocsSection title="最小可用的错误映射">
        <p>三个语言示例都把错误码映射成具名异常，方便业务侧 catch 具体类型而不是判字符串：</p>
        <CodeBlock
          language="python"
          filename="errors.py（三个示例共用同一套语义）"
          code={`class LicenseError(Exception):
    def __init__(self, code, message, request_id=None, status=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.request_id = request_id
        self.status = status

class AuthenticationError(LicenseError): ...    # 401 CLIENT_AUTH_FAILED
class LicenseRejectedError(LicenseError): ...   # 422 LICENSE_INVALID
class LicenseExpiredError(LicenseError): ...    # 410 LICENSE_EXPIRED
class LicenseSuspendedError(LicenseError): ...  # 423 LICENSE_SUSPENDED
class DeviceLimitError(LicenseError): ...       # 409 DEVICE_LIMIT_EXCEEDED
class ActivationLimitError(LicenseError): ...   # 409 ACTIVATION_LIMIT_REACHED
class RateLimitError(LicenseError): ...         # 429 RATE_LIMITED
class ServiceUnavailableError(LicenseError): ...# 503`}
        />
        <p className="text-[13px]">
          调用方只需要 <code className="font-mono text-[12.5px]">except LicenseSuspendedError</code> 就能处理暂停，
          不需要记住 423 这个数字。
        </p>
      </DocsSection>

      <DocsSection title="怎么跑这些示例">
        <CodeBlock
          language="bash"
          filename="本地验证"
          code={`# 三个示例都读同样的环境变量
export LICENSE_BASE_URL=http://127.0.0.1:3000/api/v1
export LICENSE_CLIENT_ID=<your-client-id>
export LICENSE_PRODUCT_ID=<产品 UUID>
export LICENSE_KEY=<Sandbox 授权码>

python3 sdk-examples/python/quickstart.py
node sdk-examples/node/quickstart.mjs
php sdk-examples/php/quickstart.php`}
        />
        <p className="text-[13px]">
          每个脚本都会跑两条路径：正常激活一次，再用无效授权码触发 422，确认错误映射可用。
        </p>
      </DocsSection>
    </>
  );
}
