import type { Metadata } from "next";
import { connection } from "next/server";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";
import { PUBLIC_API_ENV, originOf, readPublicBaseUrls } from "@/lib/developers/base-urls";

/**
 * 这几个页面必须按请求渲染：基础地址来自运行实例的环境变量（`PUBLIC_API_BASE_URL` /
 * `PUBLIC_SANDBOX_API_BASE_URL`），构建机上没有这些值。`cacheComponents` 下
 * `connection()` 会让路由变成阻塞式，需要显式 `instant = false` 才能构建通过。
 */
export const instant = false;


export const metadata: Metadata = { title: "浏览器扩展" };

export default async function BrowserExtensionPage() {
  // host_permissions 必须写真实 origin：占位符会让扩展装上后所有请求被浏览器拦掉，
  // 而报错信息只说「权限不足」，排查成本很高。域名来自运行实例配置。
  await connection();
  const productionOrigin = originOf(readPublicBaseUrls().production, PUBLIC_API_ENV);

  return (
    <>
      <DocsHeader
        title="浏览器扩展"
        description="扩展是半公开环境：代码可被任何人解包阅读。所有请求走 background service worker，content script 不碰网络。"
      />

      <DocsSection title="三条硬约束">
        <ul className="list-disc space-y-1 pl-5">
          <li>扩展里没有安全存储。任何写进 <code className="font-mono text-[12.5px]">chrome.storage</code> 的东西都能被读出来。</li>
          <li>因此扩展只能用公开客户端方式（X-Client-ID + 设备签名），设备私钥也只是一个「软标识」。</li>
          <li>如果业务需要强授权，把校验放到你自己的后端，扩展只拿一个短时票据。</li>
        </ul>
      </DocsSection>

      <DocsSection title="manifest 与 host 权限">
        <CodeBlock
          language="json"
          filename="manifest.json 片段"
          code={`{
  "manifest_version": 3,
  "background": { "service_worker": "background.js", "type": "module" },
  "host_permissions": ["${productionOrigin}/*"],
  "permissions": ["storage"]
}`}
        />
        <p className="text-[13px]">
          只申请实际用到的 host 权限。申请 <code className="font-mono text-[12.5px]">&lt;all_urls&gt;</code>
          会让商店审核变慢，也会让用户不敢装。
        </p>
      </DocsSection>

      <DocsSection title="service worker 会休眠">
        <p>
          MV3 的 service worker 30 秒无事件就会被回收，<strong className="text-foreground">不要</strong>用
          <code className="font-mono mx-1 text-[12.5px]">setInterval</code> 做心跳。用
          <code className="font-mono mx-1 text-[12.5px]">chrome.alarms</code>，最小间隔 1 分钟：
        </p>
        <CodeBlock
          language="javascript"
          filename="background.js"
          code={`chrome.alarms.create("license-heartbeat", { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "license-heartbeat") return;
  const { refresh_token, activation_id } = await chrome.storage.local.get([
    "refresh_token", "activation_id",
  ]);
  if (!refresh_token) return;
  const res = await fetch(\`\${BASE}/activations/heartbeat\`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Client-ID": CLIENT_ID },
    body: JSON.stringify({ activation_id, refresh_token }),
  });
  const body = await res.json();
  if (!body.ok) return;                       // 失败不覆盖已有状态
  await chrome.storage.local.set({
    refresh_token: body.data.refresh_token,   // 先落盘再继续
    entitlements: body.data.entitlements,
  });
});`}
        />
      </DocsSection>
    </>
  );
}
