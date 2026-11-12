"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Copy,
  KeyRound,
  Loader2,
  PlayCircle,
  ServerCog,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge } from "@/components/app/status-badge";
import { JsonBlock } from "@/components/security/json-block";
import { CREDENTIAL_TYPE_LABEL, type CredentialRow } from "@/components/developer/credential-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { errorMessage } from "@/lib/client/api";
import type { PageResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 演示用 Ed25519 SPKI 公钥（base64url）——只用于连通性自检，不代表真实设备。 */
const DEMO_PUBLIC_KEY = "MCowBQYDK2VwAyEAphyWiI_su3_nXJ1HapBiNI87gbJxeF0DNPf7rQANCmo";

const FLOW_STEPS = [
  {
    step: "01",
    title: "申请签名挑战",
    endpoint: "POST /api/v1/activation-challenges",
    detail: "客户端用设备私钥对应的公钥换一次性 nonce，5 分钟内有效。",
  },
  {
    step: "02",
    title: "激活授权",
    endpoint: "POST /api/v1/activations",
    detail: "用私钥签名 canonical_message，携带兑换码与 Idempotency-Key。",
  },
  {
    step: "03",
    title: "心跳续期",
    endpoint: "POST /api/v1/activations/heartbeat",
    detail: "Bearer 令牌续期并轮换；旧令牌立即失效，防止被复制使用。",
  },
  {
    step: "04",
    title: "读取权限 / 解绑",
    endpoint: "GET /api/v1/activations/{id}/entitlements",
    detail: "拉取功能权限；用户换机时调用 deactivate 释放设备位。",
  },
];

const SCOPE_ENDPOINTS: Array<{ scope: string; method: string; path: string; note: string }> = [
  { scope: "license:validate", method: "POST", path: "/api/v1/licenses/validate", note: "只校验状态，不绑定设备" },
  { scope: "activation:create", method: "POST", path: "/api/v1/activation-challenges", note: "申请挑战" },
  { scope: "activation:create", method: "POST", path: "/api/v1/activations", note: "首次激活（需幂等键）" },
  { scope: "activation:heartbeat", method: "POST", path: "/api/v1/activations/heartbeat", note: "心跳续期" },
  { scope: "activation:deactivate", method: "POST", path: "/api/v1/activations/deactivate", note: "解绑设备" },
  { scope: "entitlements:read", method: "GET", path: "/api/v1/activations/{id}/entitlements", note: "读取功能权限" },
];

function Copyable({ value, className }: { value: string; className?: string }) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5",
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{value}</code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                toast.success("已复制到剪贴板");
              } catch {
                toast.error("浏览器拒绝了剪贴板访问", { description: "请手动选中复制。" });
              }
            }}
            aria-label="复制"
          >
            <Copy className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>复制</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ApiGuideInner() {
  const router = useRouter();
  const { hasPermission, status: sessionStatus } = useSession();
  const canReadProduct = hasPermission("product:read");
  const canReadCredential = hasPermission("credential:read");
  const denied = sessionStatus === "ready" && !canReadProduct;

  const credentials = useResource<PageResult<CredentialRow>>(
    canReadCredential ? "/api/v1/admin/credentials?pageSize=50&status=active" : null,
  );

  const activeCredentials = useMemo(
    () => (credentials.data?.items ?? []).filter((item) => item.status === "active"),
    [credentials.data],
  );

  const [selectedId, setSelectedId] = useState<string>("");
  const selected = useMemo(
    () => activeCredentials.find((item) => item.id === selectedId) ?? activeCredentials[0] ?? null,
    [activeCredentials, selectedId],
  );

  const [origin, setOrigin] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; latencyMs: number; body: unknown; status: number } | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const clientId = selected?.clientId ?? "pc_xxxxxxxxxxxxxxxxxxxxxxxx";
  const productName = selected?.product.name ?? "尚未创建凭证";
  const baseUrl = origin || "http://localhost:3000";

  const curlSnippet = `# 1) 申请签名挑战
curl -X POST ${baseUrl}/api/v1/activation-challenges \\
  -H "content-type: application/json" \\
  -H "x-client-id: ${clientId}" \\
  -d '{
    "device": {
      "device_instance_id": "pc-7f3a9c21",
      "platform": "windows",
      "device_name": "工位机",
      "public_key": "${DEMO_PUBLIC_KEY}"
    }
  }'

# 2) 用私钥签名 canonical_message 后激活（幂等键必填）
curl -X POST ${baseUrl}/api/v1/activations \\
  -H "content-type: application/json" \\
  -H "x-client-id: ${clientId}" \\
  -H "idempotency-key: $(uuidgen)" \\
  -d '{
    "license_key": "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
    "challenge_id": "<上一步返回>",
    "device": { "device_instance_id": "pc-7f3a9c21", "platform": "windows",
                "device_name": "工位机", "public_key": "${DEMO_PUBLIC_KEY}" },
    "signature": "<Ed25519(canonical_message)>",
    "client_version": "2.0.7"
  }'`;

  const nodeSnippet = `import { generateKeyPairSync, sign } from "node:crypto";

const BASE = "${baseUrl}";
const CLIENT_ID = "${clientId}";

// 设备密钥只在本机生成，私钥永远不出设备
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

const device = {
  device_instance_id: "pc-7f3a9c21",
  platform: "windows",
  device_name: "工位机",
  public_key: publicKeyB64,
};

// 1) 挑战
const challenge = await fetch(\`\${BASE}/api/v1/activation-challenges\`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-client-id": CLIENT_ID },
  body: JSON.stringify({ device }),
}).then((r) => r.json());

// 2) 签名并激活
const signature = sign(null, Buffer.from(challenge.data.canonical_message), privateKey).toString("base64url");
const activation = await fetch(\`\${BASE}/api/v1/activations\`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-client-id": CLIENT_ID,
    "idempotency-key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    license_key: process.env.LICENSE_KEY,
    challenge_id: challenge.data.challenge_id,
    device,
    signature,
    client_version: "2.0.7",
  }),
}).then((r) => r.json());

console.log(activation.data.license.effective_status, activation.data.entitlements);`;

  const goSnippet = `// 桌面端 / 服务端通用：先生成一次性挑战，再用私钥签名
type Challenge struct {
    ChallengeID      string \`json:"challenge_id"\`
    CanonicalMessage string \`json:"canonical_message"\`
}

// 心跳：Bearer 令牌每次都会轮换，务必落盘新令牌
req.Header.Set("Authorization", "Bearer "+activation.AccessToken)`;

  const selfTest = async () => {
    if (!selected) {
      toast.error("先创建一条公开客户端凭证");
      return;
    }
    setTesting(true);
    setResult(null);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${baseUrl}/api/v1/activation-challenges`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-id": selected.clientId },
        body: JSON.stringify({
          device: {
            device_instance_id: `pc-console-${Date.now().toString(36)}`,
            platform: "windows",
            device_name: "控制台连通性自检",
            public_key: DEMO_PUBLIC_KEY,
          },
        }),
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const body = await response.json().catch(() => null);
      setResult({ ok: response.ok, latencyMs, body, status: response.status });
      if (response.ok) {
        toast.success("连通性正常", { description: `挑战接口返回 200，耗时 ${latencyMs} ms。` });
      } else {
        toast.error("接口返回了错误", { description: `HTTP ${response.status}，详见响应 JSON。` });
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startedAt);
      setResult({ ok: false, latencyMs, body: { error: errorMessage(err) }, status: 0 });
      toast.error("请求未能发出", { description: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[{ label: "开发者中心" }, { label: "API 接入" }]}
        title="API 接入"
        description="客户端接入授权服务的完整流程。所有示例都用你当前环境里的真实 client_id 生成，可直接复制运行。"
        meta={
          selected ? (
            <span className="text-xs text-muted-foreground">
              当前示例凭证：<span className="font-mono text-foreground">{selected.clientId}</span>（{productName}）
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">还没有生效中的凭证，示例里使用占位 client_id</span>
          )
        }
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/app/developer/credentials">
              <KeyRound className="size-3.5" /> 管理凭证
            </Link>
          </Button>
        }
      />

      {denied ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <EmptyState
            icon={<ShieldAlert className="size-5" />}
            title="没有查看接入文档的权限"
            description="需要 product:read 权限才能看到接入示例。"
            action={
              <Button variant="outline" size="sm" onClick={() => router.push("/app/dashboard")}>
                返回数据总览
              </Button>
            }
          />
        </div>
      ) : null}

      {!denied ? (
        <>
          <div className="grid items-start gap-3 lg:grid-cols-[1fr_320px]">
            <Section
              title="调用流程"
              description="四步完成接入：挑战 → 激活 → 心跳 → 权限 / 解绑。每一步都可以单独重试，激活必须带幂等键。"
            >
              <ol className="space-y-2">
                {FLOW_STEPS.map((item) => (
                  <li
                    key={item.step}
                    className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                  >
                    <span className="tabular mt-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                      {item.step}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                        {item.title}
                        <ToneBadge tone="neutral" dot={false} className="font-mono text-[10px]">
                          {item.endpoint}
                        </ToneBadge>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Section>

            <Section
              title="连通性自检"
              description="用选中的凭证真实调用一次挑战接口（不消耗授权次数）。"
            >
              <div className="space-y-2.5">
                <Select
                  value={selected?.id ?? ""}
                  onValueChange={setSelectedId}
                  disabled={activeCredentials.length === 0}
                >
                  <SelectTrigger className="w-full text-xs" aria-label="选择用于自检的凭证">
                    <SelectValue placeholder="选择生效中的凭证" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCredentials.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name} · {CREDENTIAL_TYPE_LABEL[item.type] ?? item.type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button size="sm" className="w-full" onClick={selfTest} disabled={testing || !selected}>
                  {testing ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
                  发送一次真实请求
                </Button>

                {credentials.error ? <ErrorState error={credentials.error} onRetry={credentials.refresh} compact /> : null}

                {result ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs">
                      {result.ok ? (
                        <CheckCircle2 className="size-3.5 text-success" />
                      ) : (
                        <ShieldAlert className="size-3.5 text-destructive" />
                      )}
                      <span className="font-medium text-foreground">HTTP {result.status || "未发出"}</span>
                      <span className="tabular text-muted-foreground">{result.latencyMs} ms</span>
                    </div>
                    <JsonBlock label="响应（脱敏后的真实返回）" value={result.body} />
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    自检只调用 <span className="font-mono">activation-challenges</span>，不会创建激活记录。
                  </p>
                )}
              </div>
            </Section>
          </div>

          <Section title="接口参考" description="每个 scope 对应一组端点；凭证没有对应 scope 时，请求会直接 403。">
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">scope</th>
                    <th className="px-3 py-2 font-medium">方法</th>
                    <th className="px-3 py-2 font-medium">路径</th>
                    <th className="px-3 py-2 font-medium">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {SCOPE_ENDPOINTS.map((row) => (
                    <tr key={`${row.method}-${row.path}`} className="border-t border-border/60">
                      <td className="px-3 py-2 font-mono text-[11px] text-foreground">{row.scope}</td>
                      <td className="px-3 py-2">
                        <ToneBadge tone={row.method === "GET" ? "info" : "brand"} dot={false} className="font-mono text-[10px]">
                          {row.method}
                        </ToneBadge>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{row.path}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="可复制的代码"
            description={`接入地址 ${baseUrl}，示例中的 client_id 来自当前选中的凭证。密钥一律用占位符，请勿把 secret 写进前端代码。`}
          >
            <Tabs defaultValue="curl">
              <TabsList className="h-8">
                <TabsTrigger value="curl" className="gap-1 text-xs">
                  <Terminal className="size-3.5" /> cURL
                </TabsTrigger>
                <TabsTrigger value="node" className="gap-1 text-xs">
                  <Code2 className="size-3.5" /> Node.js
                </TabsTrigger>
                <TabsTrigger value="go" className="gap-1 text-xs">
                  <ServerCog className="size-3.5" /> Go
                </TabsTrigger>
              </TabsList>

              <TabsContent value="curl" className="mt-2 space-y-2">
                <Copyable value={baseUrl} />
                <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {curlSnippet}
                </pre>
              </TabsContent>

              <TabsContent value="node" className="mt-2 space-y-2">
                <Copyable value={`CLIENT_ID=${clientId}`} />
                <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {nodeSnippet}
                </pre>
              </TabsContent>

              <TabsContent value="go" className="mt-2 space-y-2">
                <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {goSnippet}
                </pre>
              </TabsContent>
            </Tabs>
          </Section>

          <Section title="错误码对照" description="客户端按 code 分支处理，不要依赖 HTTP 状态码文本。">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["401", "CLIENT_AUTH_FAILED", "客户端标识或密钥错误，或令牌已轮换"],
                ["403", "PRODUCT_DISABLED", "产品被停用，全部请求拒绝"],
                ["404", "RESOURCE_NOT_FOUND", "授权码或激活不存在"],
                ["409", "DEVICE_LIMIT_EXCEEDED", "设备数已满，需要先解绑"],
                ["409", "IDEMPOTENCY_CONFLICT", "同一幂等键用于不同请求体"],
                ["410", "LICENSE_EXPIRED", "授权已过期"],
                ["422", "LICENSE_INVALID", "授权码格式或校验失败"],
                ["423", "LICENSE_SUSPENDED", "授权被暂停"],
                ["423", "DEVICE_BLOCKED", "该设备已被封禁"],
                ["429", "RATE_LIMITED", "触发限流，按 Retry-After 退避"],
              ].map(([status, code, note]) => (
                <div key={code} className="rounded-lg border border-border px-2.5 py-2">
                  <p className="flex items-center gap-1.5">
                    <span className="tabular rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {status}
                    </span>
                    <span className="font-mono text-[11px] text-foreground">{code}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="下一步" description="把接入串起来之后，通常还需要这几件事。">
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { href: "/app/developer/webhooks", title: "配置 Webhook", detail: "授权变更主动通知，免轮询" },
                { href: "/app/security/signing-keys", title: "启用签名密钥", detail: "离线许可与授权码报文验签" },
                { href: "/app/security/verification-logs", title: "观察验证日志", detail: "按 request_id 对齐客户端日志" },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-muted/60"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{item.title}</span>
                    <span className="block text-[11px] text-muted-foreground">{item.detail}</span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}

export default function ApiGuidePage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3" aria-busy="true">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <ApiGuideInner />
    </Suspense>
  );
}
