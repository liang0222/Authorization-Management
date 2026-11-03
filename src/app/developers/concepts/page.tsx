import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection, ParamsTable } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "核心概念" };

export default function ConceptsPage() {
  return (
    <>
      <DocsHeader
        title="核心概念"
        description="这六个概念理顺了，接口调用就不会出现「明明没过期却提示过期」这类问题。"
      />

      <DocsSection title="授权（License）">
        <p>
          一份授权 = 一个产品 + 一个客户 + 一段时间 + 一组上限。它有两条状态线，别混：
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">管理状态 admin_status</strong>：管理员做了什么。
            取值 draft / pending / active / suspended / revoked / cancelled，后两个是终态。
          </li>
          <li>
            <strong className="text-foreground">有效状态 effective_status</strong>：客户端实际能不能用。
            由管理状态、时间窗口、设备数共同算出，是只读结果。
          </li>
        </ul>
        <p>客户端只应该看 effective_status，不要去推导 admin_status。</p>
      </DocsSection>

      <DocsSection title="有效状态的优先级">
        <p>同一个时刻可能有多个条件同时成立，服务端按固定顺序取第一个：</p>
        <ParamsTable
          rows={[
            { name: "product_disabled", type: "1", description: "产品被停用，所有授权一起失效" },
            { name: "revoked", type: "2", description: "已吊销，终态，续费也不能复活" },
            { name: "cancelled", type: "3", description: "已作废，终态" },
            { name: "suspended", type: "4", description: "临时暂停，恢复后继续走后面的判断" },
            { name: "draft", type: "5", description: "草稿，还没正式签发" },
            { name: "activation_window_expired", type: "6", description: "超过激活截止时间仍未首次激活" },
            { name: "not_yet_valid", type: "7", description: "固定起算日还没到" },
            { name: "expired", type: "8", description: "已过 expires_at" },
            { name: "active", type: "9", description: "正常可用" },
          ]}
        />
        <p className="text-[13px]">
          另外两个状态只影响「新的激活」，不影响已有设备继续用：
          <code className="mx-1 font-mono text-[12.5px]">activation_limit_reached</code> 和
          <code className="mx-1 font-mono text-[12.5px]">device_limit_reached</code>。
          所以已有设备用得好好的，突然加一台机器却报 DEVICE_LIMIT_EXCEEDED，是正常的。
        </p>
      </DocsSection>

      <DocsSection title="激活（Activation）与设备">
        <p>
          一次成功激活 = 一条 activation 记录 + 一台设备。设备由{" "}
          <code className="font-mono text-[12.5px]">device_instance_id</code> 标识，由客户端自己生成
          并持久化；换机器、重装系统如果不保留它，服务端会当成新设备。
        </p>
        <CodeBlock
          language="text"
          filename="三个上限的区别"
          code={`max_devices            同时活跃的设备数（解绑后腾出名额）
max_activation_count   累计成功激活次数（解绑不返还，这是防薅羊毛的关键）
activation_deadline    必须在此之前完成首次激活，否则授权作废`}
        />
        <p>
          解绑默认<strong className="text-foreground">不返还</strong>激活次数，只腾出设备名额。
          这是有意设计：否则用户可以无限次解绑重激活来绕过试用限制。
        </p>
      </DocsSection>

      <DocsSection title="起算策略">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <code className="font-mono text-[12.5px]">on_first_activation</code>：第一次激活才开始算。
            未激活时 <code className="font-mono text-[12.5px]">expires_at</code> 是 null，别当成永久授权。
          </li>
          <li>
            <code className="font-mono text-[12.5px]">fixed_start</code>：从指定日期开始算，先买后用。
          </li>
        </ul>
        <p>
          周期用「自然月」，不是 30 天。「一季度」= 3 个自然月，「一年」= 12 个自然月，
          按授权所属时区计算，月末会做钳制（1 月 31 日 + 1 个月 = 2 月 28/29 日）。
        </p>
      </DocsSection>

      <DocsSection title="权限位（Entitlements）">
        <p>
          权限位是「这个客户买了什么功能」的快照，随激活和心跳一起下发。四个类型：
        </p>
        <CodeBlock
          language="json"
          filename="entitlements 示例"
          code={`{
  "theme_pack": "classic",        // string：枚举值
  "basic_export": true,           // boolean：开关
  "max_batch_size": 100,          // number：数值上限
  "advanced_rules": {             // json：结构化配置
    "max_rules": 20,
    "allow_script": false
  }
}`}
        />
        <p>
          权限位有版本号 <code className="font-mono text-[12.5px]">entitlements_version</code>，
          每次变化会 +1。客户端可以缓存，但心跳返回新版本时必须刷新。
        </p>
      </DocsSection>

      <DocsSection title="短期令牌与刷新令牌">
        <ParamsTable
          rows={[
            { name: "access_token", type: "Bearer JWT", required: true, description: "默认 1 小时。放 Authorization 头，不要放 URL" },
            { name: "refresh_token", type: "rt_...", required: true, description: "30 天。每次心跳换新，旧的立刻失效（防重放）" },
            { name: "refresh_token_replay", type: "安全事件", required: false, description: "旧 refresh_token 被再次使用 → 整条会话作废并告警" },
          ]}
        />
        <p>
          这意味着心跳必须<strong className="text-foreground">先把新 refresh_token 落盘再继续</strong>，
          否则进程崩溃后旧 token 已被消费，用户会被迫重新激活。
        </p>
      </DocsSection>
    </>
  );
}
