# AI 接入提示词（可直接粘贴给 AI 编程工具）

本文件是给「用 AI 写授权接入代码」的人准备的。把下面 `---` 之间的内容整段复制给 AI 编程工具，
再把项目自己的技术栈补在末尾即可。

维护说明：这份文件同时通过 `GET /developers/ai-integration-prompt.md` 对外公开，
内容以本文件为唯一来源，不要另存副本。

---

## 你的任务

为我的软件接入「子铭软件授权」API，实现：激活、心跳续期、读取功能权限、解绑、离线授权与错误处理。

在写代码之前，先读 `https://<LICENSE_API_DOMAIN>/developers/llms.txt`（索引与核心约束），
需要完整字段时读 `https://<LICENSE_API_DOMAIN>/developers/llms-full.txt`，
需要精确 schema 时读 `https://<LICENSE_API_DOMAIN>/developers/openapi.yaml`。
不要凭记忆猜端点、字段名或错误码。

## 绝对禁止（违反即为严重缺陷）

1. **禁止把任何 Secret 写进客户端。** 浏览器扩展、微信小程序、桌面应用、前端 JS 里
   只能出现公开 Client ID，不能出现服务端凭证、私钥、Webhook 签名密钥或管理端令牌。
2. **禁止把机密 Server Credential 打进可分发产物。** 桌面 EXE / 扩展包 / 小程序包都能被解包，
   里面的任何字符串都视为已公开。
3. **禁止把真实客户授权码写进示例、测试、截图、日志或提交记录。** 示例一律用 Sandbox 测试值。
4. **禁止把令牌、授权码、签名原文、Webhook 密钥写进日志。** 需要排查时只记 `request_id`。
5. **禁止自签名密钥对写死在代码里。** 设备密钥必须首次运行时生成并存进系统安全存储
   （Windows DPAPI / Keychain / Android Keystore / 扩展的 chrome.storage + 本地加密）。
6. **禁止按 `message` 或 HTTP 状态码分支。** 只按 `code` 分支。
7. **禁止在重试里复用同一个 Idempotency-Key 去发不同请求体。**

## 值分级（写代码时必须区分）

| 类别 | 例子形态 | 能放哪里 | 不能放哪里 |
| --- | --- | --- | --- |
| 示例值 | `https://sandbox.example.invalid` | 文档、注释、README | — |
| 公开 Client ID | `pc_xxx`、`cs_xxx` | 客户端产物、前端代码 | — |
| 机密 Server Credential | `private_key_jwt` 用的私钥文件 | 只在服务端；环境变量或密钥管理 | 客户端、前端、镜像层、日志 |
| 真实客户授权码 | 用户购买后拿到的码 | 只在用户输入与后端校验链路 | 示例、测试、日志、截图 |
| Webhook 签名密钥 | `whsec_…` | 只在接收 Webhook 的服务端 | 任何客户端 |

判断标准：**这段字符串会不会随软件分发给最终用户？** 会，就只能放公开值。

## 接入形态对应的认证方式

| 形态 | 认证 | 说明 |
| --- | --- | --- |
| Windows 桌面（EXE） | `X-Client-ID` + 设备 Ed25519 签名 | 设备私钥本机生成、本机保存 |
| 浏览器扩展 | `X-Client-ID` + 设备密钥 | 扩展可被解包，强授权逻辑放自有后端 |
| 微信小程序 | 只调你自己的后端 | 小程序包同样可解包，不直连授权 API |
| 网站 / 小程序后端 | `private_key_jwt`（`client_assertion`） | 私钥只在服务端，可换服务端令牌 |

## 必须实现的工程细节

- **信封**：响应是 `{ok, code, message, request_id, server_time, data}`；成功也检查 `ok`。
- **幂等**：激活必须带 `Idempotency-Key`（建议 UUIDv4），网络超时重试时复用同一个 key 与同一请求体。
- **双令牌**：`access_token` 短命（1 小时，心跳会轮换）；`refresh_token` 长命（30 天）。
  心跳返回新 `refresh_token` 时**先落盘再继续**，否则下次心跳会被判重放并整族撤销。
- **时钟**：本地时间偏差过大会让令牌「刚拿到就过期」。用响应里的 `server_time` 校正。
- **重试**：只重试网络错误 / 408 / 429 / 5xx，指数退避 + 抖动，最多 3 次；
  400/401/403/410/422/423 不要重试。401 若因 access_token 过期，可用 refresh_token 换新后重试**一次**。
- **离线**：离线授权文件是签名过的 JSON。验签要重算 `canonical_payload` 的原始字节，
  不要自己重新序列化。`valid_until` 到期前必须联网心跳。
- **错误映射**：把 API 的 `code` 映射成产品自己的用户提示，不要把服务端 message 直接弹给用户。
- **状态展示**：区分「网络断了」和「授权确实失效」。查询激活状态的接口在不可用时也返回 200，
  靠 `usable` 与 `status_reason` 判断。

## 交付要求

1. 一个可运行的最小示例（激活 → 心跳 → 读权限 → 解绑），能对着 Sandbox 跑通。
2. 完整错误码映射表，覆盖 `code` 到用户提示。
3. 重试与退避策略的代码，含上限。
4. 设备密钥的安全存储实现，说明选了什么系统存储以及为什么。
5. 一个最小测试：正常路径 + 一个失败路径（如授权码无效）。
6. 明确标注哪些值是示例值、哪些来自环境变量。

## 输出前自检

- [ ] 客户端产物里没有任何 Secret（搜索一遍 `private_key`、`whsec`、`BEGIN`）
- [ ] 所有示例值都是 Sandbox 值或占位符
- [ ] 日志里没有令牌、授权码、签名原文
- [ ] 分支判断用的是 `code`
- [ ] 重试有上限与退避，且不重试 4xx（429 除外）
- [ ] 心跳收到新 refresh_token 会落盘
- [ ] 说明了设备密钥存在哪里

---

## 给维护者的备注

- 本文件里的域名一律写占位符 `<LICENSE_API_DOMAIN>` / `<LICENSE_SANDBOX_API_DOMAIN>`，
  真实域名属于部署信息，不进公开文档。
- 端点、错误码、限流数值、Webhook 事件清单不在本文件重复列一遍：
  它们由 `public/openapi/openapi-v1.yaml` 与代码常量生成进 `llms.txt` / `llms-full.txt`，
  这里再抄一份就是第二个会过期的副本。
