import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "变更日志" };

export default function ChangelogPage() {
  return (
    <>
      <DocsHeader
        title="变更日志"
        description="同一主版本内只做向后兼容的增加；破坏性变更走 /api/v2。"
      />

      <DocsSection title="版本策略">
        <CodeBlock
          language="text"
          filename="三层版本"
          code={`URL 主版本        /api/v1          破坏性变更才会进 /api/v2
规范版本        1.5.0            OpenAPI info.version，描述文档本身
SDK 版本        python/1.0.0     独立演进，跟 API 主版本兼容`}
        />
        <p>
          「向后兼容」的具体含义：加字段可以，删字段不行；加枚举值可以，改枚举含义不行；
          放宽校验可以，收紧不行。客户端必须能忽略不认识的字段。
        </p>
      </DocsSection>

      <DocsSection title="2026-11-02 · API 1.5">
        <p className="text-foreground">新增</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            挑战响应新增 <code className="font-mono text-[12.5px]">canonical_version</code> 与带
            <code className="font-mono text-[12.5px]"> LICENSE-ACTIVATION-CHALLENGE-V1</code> 前缀的
            <code className="font-mono text-[12.5px]"> canonical_message</code>。服务端同时接受旧格式签名。
          </li>
          <li>
            激活响应补全 <code className="font-mono text-[12.5px]">refresh_token</code>、
            <code className="font-mono text-[12.5px]"> entitlements_version</code>、
            <code className="font-mono text-[12.5px]"> heartbeat_interval_seconds</code> 等字段。
          </li>
          <li>
            心跳与解绑支持 <code className="font-mono text-[12.5px]">refresh_token</code> 通道，Bearer 通道保留。
          </li>
          <li>
            新增 <code className="font-mono text-[12.5px]">POST /server/licenses/check</code>（private_key_jwt）。
          </li>
          <li>全部公开端点接入分层限流，响应带 RateLimit-* 头。</li>
        </ul>
        <p className="text-foreground">变更</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            动态段从 <code className="font-mono text-[12.5px]">/activations/&#123;id&#125;</code> 规范为
            <code className="font-mono text-[12.5px]"> /activations/&#123;activation_id&#125;</code>，
            URL 形状不变，只是参数名与文档一致。
          </li>
        </ul>
        <p className="text-foreground">不变</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>错误信封、错误码集合、HTTP 状态码映射。</li>
          <li>授权码格式与校验规则。</li>
        </ul>
      </DocsSection>

      <DocsSection title="兼容期怎么安排">
        <p>
          旧版签名格式（不带前缀的五字段拼接）会继续被接受，直到下一个主版本。
          但我们建议尽快切到 v1 —— 带版本前缀是为了将来能加字段而不破坏签名逻辑。
        </p>
        <p className="text-[13px]">
          迁移方式：直接用响应里的 <code className="font-mono text-[12.5px]">canonical_message</code> 字段签名即可，
          不需要自己拼字符串，因此这次变更对正确实现的客户端是零改动。
        </p>
      </DocsSection>
    </>
  );
}
