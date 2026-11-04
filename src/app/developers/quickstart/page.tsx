import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import {
  PUBLIC_SANDBOX_ENV,
  displayBaseUrl,
  readPublicBaseUrls,
} from "@/lib/developers/base-urls";
import { DocsHeader } from "@/components/developers/docs-shell";
import { DocsSection, ParamsTable } from "@/components/developers/endpoint";
import { CodeBlock } from "@/components/developers/code-block";

/**
 * 这几个页面必须按请求渲染：基础地址来自运行实例的环境变量（`PUBLIC_API_BASE_URL` /
 * `PUBLIC_SANDBOX_API_BASE_URL`），构建机上没有这些值。`cacheComponents` 下
 * `connection()` 会让路由变成阻塞式，需要显式 `instant = false` 才能构建通过。
 */
export const instant = false;


export const metadata: Metadata = { title: "快速开始" };

/**
 * 示例脚本按实例的沙箱基址生成。
 *
 * 以前这里写死 `https://<LICENSE_SANDBOX_DOMAIN>/api/v1`：复制粘贴这段代码的人
 * 必须先回来问「域名填什么」。现在直接把本实例配置的地址填进去，仍是
 * `os.environ.get(..., 默认值)` 形态，换环境用环境变量覆盖即可。
 */
function pythonScript(sandboxBase: string): string {
  return `import base64, json, os, urllib.request
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

BASE = os.environ.get("LICENSE_BASE_URL", "${sandboxBase}")
CLIENT_ID = os.environ["LICENSE_CLIENT_ID"]      # X-Client-ID：公开标识，不是密钥
PRODUCT_ID = os.environ["LICENSE_PRODUCT_ID"]
LICENSE_KEY = os.environ["LICENSE_KEY"]          # 只在首次激活时用一次

# 1. 设备密钥：首次生成，之后必须持久化（丢了只能解绑重激活）
KEY_PATH = os.path.expanduser("~/.demo-app/device.key")
os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
if os.path.exists(KEY_PATH):
    private_key = serialization.load_der_private_key(open(KEY_PATH, "rb").read(), None)
else:
    private_key = Ed25519PrivateKey.generate()
    open(KEY_PATH, "wb").write(private_key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
public_der = private_key.public_key().public_bytes(
    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
)
b64 = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")

def call(path, payload, headers=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Client-ID": CLIENT_ID, **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as error:
        body = json.loads(error.read())
        raise RuntimeError(f"{body['code']}: {body['message']}") from None

# 2. 申请挑战
device_instance_id = "demo-device-" + b64(os.urandom(6)).lower()
device = {
    "device_instance_id": device_instance_id,
    "platform": "windows",
    "device_name": "Demo PC",
    "public_key": b64(public_der),
}
challenge = call("/activation-challenges", {"product_id": PRODUCT_ID, "device": device})["data"]

# 3. 签名规范化消息（服务端已拼好 v1 前缀，直接签这串字符串）
signature = b64(private_key.sign(challenge["canonical_message"].encode()))

# 4. 激活：Idempotency-Key 让重试安全，同一个 key 不会产生第二份激活
activation = call(
    "/activations",
    {
        "product_id": PRODUCT_ID,
        "license_key": LICENSE_KEY,
        "challenge_id": challenge["challenge_id"],
        "device": {**device, "signature": signature},
        "client": {"app_version": "1.0.0", "sdk_version": "python-example"},
    },
    {"Idempotency-Key": f"activate-{device_instance_id}"},
)["data"]

print("激活成功:", activation["activation_id"], activation["effective_status"])
print("到期时间:", activation["expires_at"])
print("权限位:", json.dumps(activation["entitlements"], ensure_ascii=False, indent=2))

# 5. 心跳：refresh_token 会轮换，必须把新值写回本地，旧值立即作废
heartbeat = call(
    "/activations/heartbeat",
    {
        "activation_id": activation["activation_id"],
        "refresh_token": activation["refresh_token"],
        "client": {"app_version": "1.0.0", "sdk_version": "python-example"},
    },
)["data"]
print("心跳:", heartbeat["effective_status"], "下次心跳(秒):", heartbeat["next_heartbeat_seconds"])
`;
}

export default async function QuickstartPage() {
  // 基础地址来自运行实例的环境变量，构建机上没有 → 必须等到请求到达再读。
  await connection();
  const urls = readPublicBaseUrls();
  const sandboxBase = displayBaseUrl(urls.sandbox, PUBLIC_SANDBOX_ENV);

  return (
    <>
      <DocsHeader
        badge="约 15 分钟"
        title="快速开始"
        description="下面这段代码是完整可运行的：生成设备密钥、申请挑战、签名激活、心跳续期。保存成 quickstart.py 就能跑。"
      />

      <DocsSection title="准备三样东西">
        <p>在后台「API 凭证」里创建公开客户端后，你会拿到：</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <code className="font-mono text-[12.5px]">X-Client-ID</code>，例如{" "}
            <code className="font-mono text-[12.5px]">&lt;your-client-id&gt;</code>（后台创建凭证时生成，形如 pc_desktop_xxxxxxxxxxxx）。这是公开标识，
            会出现在客户端二进制里 —— 它不是密钥。
          </li>
          <li>
            <code className="font-mono text-[12.5px]">product_id</code>：产品 UUID，在「软件产品」页可复制。
          </li>
          <li>一份 Sandbox 环境的测试授权码，格式形如 XXXXX-XXXXX-XXXXX-XXXXX-XXXXX。</li>
        </ul>
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[13px] text-foreground">
          授权码、设备私钥、服务端 Secret 都不要进 Git，也不要打进安装包。授权码只在首次激活时用到一次。
        </p>
      </DocsSection>

      <DocsSection title="完整脚本（Python 3.9+）">
        <CodeBlock filename="quickstart.py" language="python" code={pythonScript(sandboxBase)} />
        <p>
          唯一依赖：<code className="font-mono text-[12.5px]">pip install cryptography</code>。运行前设置
          <code className="font-mono text-[12.5px]"> LICENSE_BASE_URL</code>、
          <code className="font-mono text-[12.5px]"> LICENSE_CLIENT_ID</code>、
          <code className="font-mono text-[12.5px]"> LICENSE_PRODUCT_ID</code>、
          <code className="font-mono text-[12.5px]"> LICENSE_KEY</code> 四个环境变量。
        </p>
      </DocsSection>

      <DocsSection title="四步各自在做什么">
        <ParamsTable
          caption="调用链"
          rows={[
            { name: "POST /activation-challenges", type: "JSON", required: true, description: "生成 32 字节 nonce，5 分钟有效且只能用一次" },
            { name: "sign(canonical_message)", type: "本地 Ed25519", required: true, description: "对服务端返回的字符串签名；Ed25519 不需要先哈希" },
            { name: "POST /activations", type: "Idempotency-Key", required: true, description: "验签并占用设备名额，返回 access_token 与 refresh_token" },
            { name: "POST /activations/heartbeat", type: "refresh_token", required: false, description: "每 15 分钟一次；refresh_token 每次轮换，旧值立即失效" },
          ]}
        />
      </DocsSection>

      <DocsSection title="出错了怎么读">
        <p>
          所有错误都是同一个信封。<code className="font-mono text-[12.5px]">code</code> 稳定，
          <code className="font-mono text-[12.5px]"> message</code> 只是给人看的、可能改。分支判断永远用 code。
        </p>
        <CodeBlock
          language="json"
          filename="409 Conflict"
          code={`{
  "ok": false,
  "code": "DEVICE_LIMIT_EXCEEDED",
  "message": "该授权已达到设备数量上限",
  "request_id": "req_9f2c...",
  "server_time": "2026-11-02T09:00:00.000Z"
}`}
        />
        <p>
          把 <code className="font-mono text-[12.5px]">request_id</code> 交给管理员，后台「验证日志」里能查到这条请求的完整记录。
        </p>
      </DocsSection>

      <DocsSection title="下一步">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            上生产前先看{" "}
            <Link href="/developers/authentication" className="text-primary hover:underline">
              认证
            </Link>
            ，特别是「哪种客户端用哪种方式」那张表。
          </li>
          <li>
            处理过期/暂停逻辑前看{" "}
            <Link href="/developers/concepts" className="text-primary hover:underline">
              核心概念
            </Link>
            里的 effective_status 优先级。
          </li>
          <li>
            要接收状态变更看{" "}
            <Link href="/developers/webhooks" className="text-primary hover:underline">
              Webhook
            </Link>
            。
          </li>
        </ul>
      </DocsSection>
    </>
  );
}
