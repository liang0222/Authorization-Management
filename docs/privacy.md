# 数据隐私与保留

对应规格 17.5。本文说明系统采集哪些数据、为什么采集、保留多久、怎么导出和删除。

## 1. 采集范围

| 数据类别 | 字段 | 用途 | 是否必须 |
| --- | --- | --- | --- |
| 客户主体 | `customers.name`、`email`、`company`、`notes` | 授权归属与联系 | 必须 |
| 客户身份绑定 | `customer_identities.provider/subject` | 第三方账号关联（如工单系统） | 可选 |
| 设备 | `devices.instance_id`、`name`、`platform`、`public_key_thumbprint` | 设备绑定与激活配额 | 必须 |
| 网络 | `api_request_logs.ip`、`activation_events.ip` | 风控、排障、滥用定位 | 必须（可脱敏展示） |
| 审计 | `audit_logs.actor_id`、`ip`、`user_agent` | 合规留痕 | 必须 |
| 授权 | `license_keys.key_hash`、`key_prefix`、`key_last4` | 校验与人工核对 | 必须 |

**不采集**：真实姓名、身份证件、支付卡号、精确地理位置、通讯录、剪贴板、屏幕内容。
客户端上报的设备信息只用于区分设备，不做指纹画像。

## 2. 保留期限

| 数据 | 保留 | 说明 |
| --- | --- | --- |
| `api_request_logs` | 90 天 | 超期按日清理；聚合统计保留 |
| `activation_events` | 180 天 | 心跳不逐条落库，只记录状态变化 |
| `audit_logs` | 3 年 | 合规要求，追加式，不可修改 |
| `license_keys`（含已撤销） | 授权终止后 3 年 | 撤销需可追溯 |
| `customers` | 合作期间 + 2 年 | 删除走匿名化，不物理删除授权与审计记录 |
| 备份包 | 按策略 `retention`（默认 7 日 / 4 周 / 3 月） | 加密存储，过期由保留策略清理 |

清理由 `scripts/retention-cleanup.mts` 执行，默认 dry-run，`--apply` 才删：

```bash
npx tsx scripts/retention-cleanup.mts           # 先看会删多少
npx tsx scripts/retention-cleanup.mts --apply   # 真删
```

已装 systemd timer `licensing-saas-retention.timer`（每日 04:30，`Persistent=true` 补跑，
`RandomizedDelaySec=300` 错峰）。查看与手动触发：

```bash
systemctl list-timers licensing-saas-retention.timer
systemctl start licensing-saas-retention.service
journalctl -u licensing-saas-retention.service -n 20 --no-pager
```

`audit_logs` 不在清理范围内（3 年合规留档），备份包过期由备份保留策略处理。

## 3. 脱敏

- 后台列表展示授权码为 `••••-••••-••••-3456`；设备指纹与 IP 在详情页默认掩码。
- 日志与审计不含授权码明文、密码、完整 Token、私钥、完整设备指纹。
- 公开状态页只输出聚合数字（请求量、成功率、P95），不含租户、产品、IP 或错误明细。

## 4. 数据导出

管理员可在授权列表按产品/客户筛选后导出 CSV（页面右上角「导出」）。
整租户导出目前需要直接查库，未提供一键导出接口 —— 单租户部署下可接受，
多租户场景需要补 `GET /admin/organizations/{id}/export`。

## 5. 删除与匿名化

| 请求类型 | 处理 |
| --- | --- |
| 删除客户联系方式 | 直接更新 `customers`，保留授权与审计（法定保留） |
| 删除设备 | 解绑并标记 `status=revoked`，历史激活记录保留 |
| 删除组织 | 停用组织 → 停止签发 → 保留审计；物理删除需人工执行并记录 |
| 删除日志中的 IP | 按保留策略自然过期；如急需，执行 `UPDATE ... SET ip = NULL` 并写审计 |

删除操作本身写 `audit_logs`（`action=customer.delete` 等），满足“删除可审计”。

## 6. 跨境与第三方

- 系统不向第三方发送客户数据；Webhook 由租户自行配置，属于租户自身的数据出口。
- 备份可配置到境外对象存储，是否允许取决于部署方的合规判断，系统不做限制。
