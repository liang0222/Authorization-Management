# API 契约

后台前端与客户端 SDK 共用的 HTTP 契约。全部路由在 `src/app/api/v1/`，共 66 个 route handler（管理 50 / 认证 5 / 公开协议 11）；
另有 5 个 `src/app/developers/*` 的静态文档 route（llms / openapi / ai 提示词），合计 71 个。

- 管理接口前缀：`/api/v1/admin/*`（需登录 + RBAC）
- 认证接口前缀：`/api/v1/auth/*`
- 公开客户端接口前缀：`/api/v1/*`（需 `x-client-id`，激活类还要设备签名）

---

## 1. 统一响应

### 1.1 成功

```json
{
  "ok": true,
  "code": "OK",
  "message": "",
  "request_id": "0f4f2c1a-...",
  "server_time": "2026-11-02T06:30:00.000Z",
  "data": { }
}
```

### 1.2 失败

```json
{
  "ok": false,
  "code": "DEVICE_LIMIT_EXCEEDED",
  "message": "该授权已达到设备数量上限",
  "request_id": "0f4f2c1a-...",
  "server_time": "2026-11-02T06:30:00.000Z",
  "details": { "fieldErrors": { "code": "该产品编码已被占用" } }
}
```

`details.fieldErrors` 是 `Record<string, string>`（每字段一条），前端 `ClientApiError.fieldErrors`
直接读它回填到 `FormField`。

### 1.3 错误码表

| HTTP | code | 触发场景 | 前端处理 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数不合法、周期越界、功能码未定义 | 字段级提示 |
| 401 | `CLIENT_AUTH_FAILED` | 未登录 / 凭证无效 / Token 失效 | 跳登录页 |
| 401 | `MFA_REQUIRED` | 账号开启二次验证但未提供验证码 | 登录页展开验证码输入 |
| 403 | `FORBIDDEN` | 角色缺权限、CSRF 校验失败 | Toast + 按钮不得再点 |
| 403 | `PRODUCT_DISABLED` | 产品已停用 | 提示联系管理员 |
| 404 | `RESOURCE_NOT_FOUND` | 记录不存在或不属于本组织 | 详情页显示错误态 |
| 409 | `LICENSE_ALREADY_BOUND` | 设备已绑定该授权 | 客户端提示已激活 |
| 409 | `DEVICE_LIMIT_EXCEEDED` | 活跃设备数达上限 | 客户端提示先解绑 |
| 409 | `ACTIVATION_LIMIT_REACHED` | 累计激活次数达上限 | 提示联系客服加次数 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同 Idempotency-Key 不同请求体 | 客户端换键重试 |
| 409 | `CODE_CONFLICT` | 编码/邮箱已存在 | 字段级提示 |
| 410 | `LICENSE_EXPIRED` | 授权已过期 | 客户端提示续费 |
| 410 | `ACTIVATION_WINDOW_EXPIRED` | 超过激活截止日 | 客户端提示已失效 |
| 422 | `LICENSE_INVALID` | 授权码格式或签名不对 | 提示重新输入 |
| 422 | `PRODUCT_MISMATCH` | 授权属于其它产品 | 提示用错客户端 |
| 423 | `LICENSE_SUSPENDED` | 授权被暂停 | 客户端提示联系客服 |
| 423 | `DEVICE_BLOCKED` | 设备被禁用 | 客户端提示设备被封 |
| 429 | `RATE_LIMITED` | 登录/激活频率超限 | 展示 `retry_after_seconds` 倒计时 |
| 500 | `INTERNAL_ERROR` | 未预期异常 | 错误态 + 重试 |
| 503 | `LICENSE_SERVICE_UNAVAILABLE` | 依赖不可用 | 错误态 + 重试 |

---

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | body `{email, password, totpCode?}`；成功同时下发 `lic_session`（HttpOnly）与 `lic_csrf`（可读） |
| POST | `/api/v1/auth/logout` | 吊销当前会话 |
| GET | `/api/v1/auth/session` | 返回 `{user, organization, role, permissions[], navGroups[]}` |
| POST | `/api/v1/auth/forgot-password` | 防枚举：无论邮箱是否存在都返回相同文案；开发模式回传 `devResetUrl` |
| POST | `/api/v1/auth/reset-password` | 改密成功后吊销该用户全部会话 |

**登录限流**（`src/app/api/v1/auth/login/route.ts`）：只对**失败**计数。
两个桶：同 IP + 同邮箱 8 次 / 5 分钟、同 IP 30 次 / 5 分钟。成功登录会清零账号桶，
同 IP 总量桶保留用于阻断跨账号扫描。

**写操作 CSRF**：所有 `POST/PATCH/PUT/DELETE` 必须带 `x-csrf-token`，值取自 `lic_csrf`
cookie（双提交模式）。缺失返回 `403 FORBIDDEN`。前端 `apiRequest` 自动附加。

---

## 3. 管理接口

### 3.0 列表分页（v1.5 起支持游标）

所有管理端列表接口同时支持两种分页方式，**响应体永远带两套字段**，老前端不需要改：

| 方式 | 请求 | 说明 |
| --- | --- | --- |
| 页码（旧） | `?page=2&pageSize=20` | 兼容保留；`pageSize` 与 `limit` 等价 |
| 游标（推荐） | `?limit=20&cursor=<next_cursor>` | 深翻页不会随 offset 增大而变慢，也不会因为新增数据而重复/漏行 |

```json
{
  "ok": true,
  "code": "OK",
  "data": {
    "items": [],
    "page": 1,
    "pageSize": 20,
    "total": 232,
    "pageCount": 12,
    "next_cursor": "c1.eyJvIjoyMCwicyI6Ii9hcGkvdjEvYWRtaW4vbGljZW5zZXMifQ.K7m3…",
    "has_more": true,
    "pagination": { "next_cursor": "c1.…", "has_more": true, "limit": 20 }
  }
}
```

规则（实现在 `src/lib/domain/cursor.ts`）：

- `limit` 默认 **20**，上限 **100**；超过 100 按 100 处理。
- `next_cursor` 为 `null` 且 `has_more: false` 表示已经是最后一页。
- 游标是 **HMAC-SHA256 签名的偏移量**，并绑定请求路径。服务端用 `SESSION_SECRET` 派生的密钥签名，
  篡改一个字节、换一个接口复用、或跨环境使用都会被判为无效。
- 游标无效/过期返回 **400 `INVALID_REQUEST`**，文案「游标无效或已过期，请从第一页重新请求」。
  客户端应当**丢弃游标、从第一页重新拉**，不要把游标当持久状态存库。
- 不要把游标解析成 JSON 或试图自己构造 —— 格式不是契约，随时可能变。
- 同时传 `page` 与 `cursor` 时以 `cursor` 为准。

```bash
# 第一页
curl -s "http://127.0.0.1:3100/api/v1/admin/licenses?limit=20" -b cookies.txt
# 下一页（把上一页的 next_cursor 原样带回来）
curl -s "http://127.0.0.1:3100/api/v1/admin/licenses?limit=20&cursor=c1.…" -b cookies.txt
```

### 3.1 概览与下拉

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/dashboard` | KPI、状态分布、14 天验证趋势、30 天内到期、最近审计 |
| GET | `/admin/lookups` | 产品 / 客户 / 套餐 / 功能下拉数据 |

`GET /admin/dashboard` 返回实测样例（种子数据）：

```json
{
  "licensesTotal": 240, "licensesActive": 160, "expiringIn30Days": 32,
  "suspended": 16, "revoked": 12, "activeDevices": 444,
  "verification24h": { "total": 40, "failed": 5, "successRate": 0.875 }
}
```

### 3.2 产品

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/admin/products` | `product:read` | 分页 + `status`/`productType`/`q`；每行带 `counts{features,licenses,credentials,plans,activeDevices}` |
| POST | `/admin/products` | `product:write` | `{code,name,productType,...}`；重码 409 |
| GET | `/admin/products/[id]` | `product:read` | 详情 + features + credentials + plans + `counts.licenseByStatus` |
| PATCH | `/admin/products/[id]` | `product:write` | 可改 status（active/disabled/archived），状态变化写审计 `product.status_change` |
| GET/POST | `/admin/products/[id]/features` | `feature:read` / `feature:write` | 产品下的功能定义 |

### 3.3 客户 / 套餐 / 功能

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET/POST | `/admin/customers` | `customer:read` / `customer:write` | 列表带 `counts{licenses,activeLicenses,identities}` |
| GET/PATCH | `/admin/customers/[id]` | 同上 | 详情含授权列表与第三方身份 |
| GET/POST | `/admin/plans` | `plan:read` / `plan:write` | `duration` 为判别联合：`{unit:"day",value:1..3650}` / `{unit:"month",value:1..120}` / `{unit:"lifetime",value:0}` |
| GET/PATCH | `/admin/plans/[id]` | 同上 | PATCH 的 `features` 是**全量替换** `plan_features` |
| GET | `/admin/features` | `feature:read` | 跨产品功能列表，带 `planCount`/`licenseCount` |
| PATCH | `/admin/features/[id]` | `feature:write` | 只改 name/description/defaultValue/status（code 与产品是权限键，不可改） |
| DELETE | `/admin/features/[id]` | `feature:write` | 归档；被引用时 409 |

`plan.features` 必须引用产品已定义的功能码，否则 400「套餐包含未定义的功能编码：…」。

### 3.4 授权

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/admin/licenses` | `license:read` | 分页 + `status`（**计算状态**）/`adminStatus`/`productId`/`customerId`/`q`/`sort`/`order` |
| POST | `/admin/licenses` | `license:issue` | 签发，返回明文授权码（仅此一次） |
| GET/PATCH | `/admin/licenses/[id]` | `license:read` / `license:issue` | 详情 / 修改备注等 |
| POST | `/admin/licenses/[id]/[action]` | 见下 | `suspend` `resume` `revoke` `cancel` `renew` `rekey` `reset-activation-count` `publish` |
| GET | `/admin/licenses/[id]/activations` | `activation:read` | 设备列表 + 配额 |
| POST | `/admin/licenses/batch` | `license:issue` | 批量操作，单次 ≤ 50 |
| GET | `/admin/licenses/export` | `license:read` | CSV 脱敏导出（授权码只留后四位），导出动作写审计 |

- `status`（筛选）走的是**计算状态**：SQL 里复刻了 `effective_status` 的 CASE 表达式，
  与前端徽章、公开 API 返回完全一致。`q` 支持授权码后四位、客户名、授权 ID 片段。
- 终态（`revoked`/`canceled`）不可再变更，任何动作返回 409。
- 永久授权（`lifetime`）续费返回 400。

### 3.5 激活与设备

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/admin/devices` | `activation:read` | 跨授权设备列表 + `summary`；支持 `online` 过滤 |
| GET | `/admin/devices/[id]` | `activation:read` | 设备档案 + 激活历史 + 事件流 |
| POST | `/admin/activations/[id]/[action]` | `activation:release` / `activation:block` | `release` / `block` / `unblock` |

### 3.6 开发者中心

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET/POST | `/admin/credentials` | `credential:read` / `credential:write` | `secret` 只存 SHA-256，明文仅在创建/轮换时返回一次 |
| PATCH | `/admin/credentials/[id]` | `credential:write` | `action`: `rotate`（仅 confidential_server）/ `disable` / `enable` / `update` |
| DELETE | `/admin/credentials/[id]` | `credential:write` | 归档 |
| GET/POST | `/admin/signing-keys` | `signingkey:read` / `signingkey:write` | 指纹 = SHA-256 前 16 字节 hex；私钥写 `.keys/<kid>.pem`，权限 0600 |
| PATCH | `/admin/signing-keys/[id]` | `signingkey:write` | `activate` / `retire` / `revoke` 状态机 |
| GET/POST | `/admin/webhooks` | `webhook:read` / `webhook:write` | url 仅允许 https 或 localhost；签名密钥只返回一次 |
| PATCH/DELETE | `/admin/webhooks/[id]` | `webhook:write` | 改 url/事件/状态；DELETE = 归档 |
| GET | `/admin/webhooks/[id]/deliveries` | `webhook:read` | 投递记录 |
| POST | `/admin/webhook-deliveries/[id]/replay` | `webhook:write` | 重投（接收端需按 `event_id` 幂等） |

凭证 scope 白名单：`license:validate`、`activation:create`、`activation:heartbeat`、
`activation:deactivate`、`entitlements:read`、`offline:grant`、`server:check`、`server:assign`。

Webhook 事件（10 种）：`license.activated`、`license.renewed`、`license.suspended`、
`license.resumed`、`license.revoked`、`license.expired`、`activation.created`、
`activation.released`、`activation.blocked`、`entitlements.updated`。

### 3.7 安全审计

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/admin/verification-logs` | `verification:read` | 分页 + `status`/`productId`/`route`/`q`/`from`/`to`；返回 `summary{totalRequests,successCount,successRate,clientErrorCount,serverErrorCount,avgLatencyMs}` |
| GET | `/admin/audit-logs` | `audit:read` | 分页 + `action`/`resourceType`/`actorId`/`from`/`to`/`q`；固定 `created_at DESC` |

### 3.8 系统管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET/POST | `/admin/members` | `member:read` / `member:write` | 邀请成员；owner 不可邀请，同邮箱重复 409 |
| PATCH/DELETE | `/admin/members/[id]` | `member:write` | 改角色/状态；owner 成员 403；停用自己 400 |
| GET/POST | `/admin/roles` | `member:read` / `member:write` | 角色列表带 `availablePermissions`；预设码重复 409 |
| GET/PATCH | `/admin/organization` | `org:read` / `org:write` | 改名称/时区；时区用 `Intl` 校验，返回 `notice` 说明不影响已签发授权 |
| GET/PATCH | `/admin/settings` | `settings:read` / `settings:write` | 5 个白名单键：`apiRequestLogRetentionDays`(1–365)、`auditLogRetentionDays`(30–3650)、`defaultSessionTtlHours`(1–168)、`webhookMaxRetries`(0–20)、`allowPublicCredentialRotation`(boolean)；越界 400 + fieldErrors |
| GET/PATCH/POST/PUT | `/admin/me` | 登录即可 | 资料 / 改密（PUT）/ MFA（`?action=begin\|confirm\|disable`） |

---

## 4. 公开客户端接口

客户端接入流程：**拿挑战 → 签名 → 激活 → 心跳 → 读权限 → 解绑**。

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/activation-challenges` | `x-client-id` | body `{device:{device_instance_id,platform,device_name,public_key}}` → `{challenge_id,nonce,expires_at,signing_algorithm,canonical_version,canonical_message}` |
| POST | `/v1/activations` | `x-client-id` + `Idempotency-Key` | body `{license_key,challenge_id,device,signature,client_version}` → 201 `{activation_id,access_token,license:{expires_at,effective_status},entitlements}` |
| POST | `/v1/activations/heartbeat` | `Authorization: Bearer` | 返回新 `accessToken`（旧的立即失效） |
| GET | `/v1/activations/[id]/entitlements` | Bearer | 返回功能开关 `{features:{...}}` |
| POST | `/v1/activations/deactivate` | Bearer | 解绑（默认不返还激活次数） |
| POST | `/v1/licenses/validate` | `x-client-id` | 只校验不占设备，用于「预检查」 |

v1.5 新增的三个公开端点在下一节，它们不在「激活主链路」上，但客户端离线和强授权要用。

### 4.1 挑战规范化消息（v1，带版本前缀）

第一行是固定协议标签 `LICENSE-ACTIVATION-CHALLENGE-V1`，随后六个字段，顺序固定。
除最后一行外每行一个 LF，**末尾不加 LF**（客户端必须逐字一致，否则签名失败）：

```
LICENSE-ACTIVATION-CHALLENGE-V1
challenge_id
nonce
product_id
device_instance_id
expires_at
```

上面 6 行是 6 个独立行，每行之间一个 LF，`expires_at` 之后不再追加 LF——多一个或少一个都会验签失败。
旧的无前缀五字段版保留为 legacy：验签按响应里的 `canonical_version` 双版本兼容，
新客户端请直接对 `canonical_message` 字段签名，不要自己拼字符串。

### 4.4 v1.5 新增的公开端点

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/activations/{activation_id}` | Bearer | 查当前激活状态。**不可用也返回 200**，靠 `usable` / `status_reason` 区分「网络断了」与「授权真失效」 |
| POST | `/v1/offline-grants` | Bearer | 签离线授权文件。`valid_until = min(now + grace_seconds, 授权到期时间)`，最长 90 天；签名覆盖 `canonicalJson(grant)` |
| POST | `/v1/oauth/token` | `private_key_jwt` | 服务端用断言换短期令牌。只支持 `private_key_jwt`，显式拒绝 `client_credentials` 与 `client_secret`；scope 只能收窄 |

三个端点都已在 `public/openapi/openapi-v1.yaml` 里声明，并被 `tests/unit/openapi.test.ts`
的正反向比对覆盖（代码有、契约无会失败，反之亦然）。

### 4.2 激活的事务语义

首次激活在单个事务内完成：`SELECT ... FOR UPDATE` 锁授权行 → 校验状态与上限 → 写
`starts_at`（若为首激活且策略为 `on_first_activation`）、`expires_at` → `activation_count + 1`
→ 写激活与设备记录 → 入队 Webhook。并发实测：`max_devices=1` 时两个设备同时激活，
结果恒为 `[201 OK, 409 DEVICE_LIMIT_EXCEEDED]`，活跃设备数不会突破上限。

### 4.3 幂等

同 `Idempotency-Key` + 同请求体 → 回放首次结果，响应头带 `x-idempotent-replay: true`；
同 key 不同请求体 → `409 IDEMPOTENCY_CONFLICT`。

---

## 5. 前端对接清单

| 页面 | 主要接口 |
| --- | --- |
| `/app/dashboard` | `GET /admin/dashboard` |
| `/app/products`、`/app/products/[id]` | `GET/POST /admin/products`、`GET/PATCH /admin/products/[id]`、`POST /admin/products/[id]/features` |
| `/app/customers` | `GET/POST /admin/customers`、`GET/PATCH /admin/customers/[id]` |
| `/app/plans` | `GET/POST /admin/plans`、`GET/PATCH /admin/plans/[id]` |
| `/app/features` | `GET /admin/features`、`PATCH/DELETE /admin/features/[id]` |
| `/app/licenses` | `GET/POST /admin/licenses`、`POST /admin/licenses/batch`、`GET /admin/licenses/export` |
| `/app/licenses/[id]` | `GET /admin/licenses/[id]`、`POST /admin/licenses/[id]/[action]`、`GET /admin/licenses/[id]/activations`、`POST /admin/activations/[id]/[action]` |
| `/app/devices` | `GET /admin/devices` |
| `/app/developer/api` | `GET /admin/credentials`、实调 `POST /v1/activation-challenges`（连通性自检） |
| `/app/developer/credentials` | `GET/POST /admin/credentials`、`PATCH/DELETE /admin/credentials/[id]` |
| `/app/developer/webhooks`、`/[id]` | `GET/POST /admin/webhooks`、`PATCH/DELETE /admin/webhooks/[id]`、`GET /admin/webhooks/[id]/deliveries`、`POST /admin/webhook-deliveries/[id]/replay` |
| `/app/security/signing-keys` | `GET/POST /admin/signing-keys`、`PATCH /admin/signing-keys/[id]` |
| `/app/security/verification-logs` | `GET /admin/verification-logs` |
| `/app/security/audit-logs` | `GET /admin/audit-logs` |
| `/app/settings/members` | `GET/POST /admin/members`、`PATCH/DELETE /admin/members/[id]`、`GET /admin/roles` |
| `/app/settings/organization` | `GET/PATCH /admin/organization` |
| `/app/settings/system` | `GET/PATCH /admin/settings` |
| `/app/settings/profile` | `GET/PATCH/POST/PUT /admin/me` |
| `/(auth)/*` | `POST /auth/login`、`/auth/logout`、`GET /auth/session`、`POST /auth/forgot-password`、`/auth/reset-password` |
