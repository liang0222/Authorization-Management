import type { Metadata } from "next";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

export const metadata: Metadata = { title: "Windows 桌面端" };

export default function WindowsPage() {
  return (
    <>
      <DocsHeader
        title="Windows 桌面端"
        description="EXE 是公开客户端：只用 X-Client-ID + 设备签名，绝不放 Secret。私钥存 Windows DPAPI，不要放注册表明文。"
      />

      <DocsSection title="私钥存哪里">
        <CodeBlock
          language="text"
          filename="存储位置对比"
          code={`%APPDATA%\\<YourApp>\\device.key        推荐：用户级目录，随用户漫游
DPAPI (CryptProtectData)             更稳：绑定当前 Windows 账户，复制到别的机器解不开
注册表 HKCU\\Software\\<YourApp>       不推荐：明文易被导出
程序安装目录                          不要：多用户共享，且可能无写权限`}
        />
        <p>
          DPAPI 的价值在于：即使攻击者拿到了磁盘文件，换一台机器也解不开。
          代价是用户重装系统或换机后必须重新激活 —— 这是正确的取舍。
        </p>
      </DocsSection>

      <DocsSection title="注意点">
        <ul className="list-disc space-y-1 pl-5">
          <li>设备指纹别只用 MAC 地址：网卡换、虚拟机克隆都会变。用「首次生成的 UUID + 持久化」比硬件指纹可靠。</li>
          <li>文件名不要叫 <code className="font-mono text-[12.5px]">license.key</code> 这种一眼就知道是密钥的名字。</li>
          <li>更新程序时不要覆盖 <code className="font-mono text-[12.5px]">%APPDATA%</code> 下的设备密钥。</li>
          <li>卸载时是否删除密钥要产品决策：删了用户重装要重新激活，不删则可能残留。</li>
        </ul>
      </DocsSection>

      <DocsSection title="离线场景">
        <p>
          断网时不要直接放行，也不要直接拒绝。正确做法是：本地缓存上次心跳结果 + 一个宽限期
          （例如 72 小时），宽限期内允许使用但提示「请联网验证」。
        </p>
        <p className="text-[13px]">
          缓存里必须存 <code className="font-mono text-[12.5px]">effective_status</code> 与
          <code className="font-mono text-[12.5px]"> expires_at</code>，并在启动时用本地时间与
          <code className="font-mono text-[12.5px]"> server_time</code> 的偏移做校正 —— 用户改系统时间不能延长授权。
        </p>
      </DocsSection>
    </>
  );
}
