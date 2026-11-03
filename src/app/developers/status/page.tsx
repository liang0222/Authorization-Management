import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { PublicStatusPanel } from "@/components/developers/status-panel";

export const metadata: Metadata = { title: "服务状态" };

export default function StatusPage() {
  return (
    <>
      <DocsHeader
        title="服务状态"
        description="下面的数字来自真实请求日志的聚合，每 30 秒刷新一次。只统计最近 24 小时，不包含任何租户或 IP 信息。"
      />
      <PublicStatusPanel />
      <DocsSection title="这个页面统计什么">
        <ul className="list-disc space-y-1 pl-5">
          <li>请求总量：最近 24 小时内所有 /api/v1 调用（含失败）。</li>
          <li>成功率：HTTP 状态 &lt; 400 的占比。4xx 也算失败——客户端确实没拿到想要的东西。</li>
          <li>P95 延迟：95% 的请求在多少毫秒内完成，比平均值更能反映体感。</li>
        </ul>
        <p className="text-[13px]">
          数据源是 <code className="font-mono text-[12.5px]">GET /api/v1/status</code>，公开可调，带限流。
        </p>
      </DocsSection>
    </>
  );
}
