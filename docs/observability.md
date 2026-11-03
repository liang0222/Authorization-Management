# 可观测性、健康检查与告警

对应规格 18。目标是：出问题时能在 5 分钟内回答“是数据库、签名、还是上游”。

---

## 1. 三个探针

| 端点 | 检查内容 | 失败含义 | 谁该调用 |
| --- | --- | --- | --- |
| `GET /health/live` | 进程存活（不查库） | 进程死了 | systemd / 容器编排 |
| `GET /health/ready` | `select 1` + 存在 active 签名密钥 + 密钥目录可读 | 不能接流量 | 负载均衡 / 部署脚本 |
| `GET /metrics` | Prometheus 文本指标 | —— | 内网 Prometheus |

```bash
curl -s http://127.0.0.1:3100/health/live
# {"status":"ok","uptime_seconds":1234}

curl -s http://127.0.0.1:3100/health/ready
# {"status":"ready","env":"production","checks":{"database":null,"signing_keys":null}}
# 不健康时返回 503，checks 里对应项是错误码，不含连接串或路径
```

**注意**：本项目没有 `/api/health`。旧文档里提到的 `/api/health` 是笔误，
对外健康检查请用 `/api/v1/status`（公开、只读、带限流）。

`/metrics` 的保护是双层的：

1. 应用层：必须带 `Authorization: Bearer $METRICS_TOKEN`，**未配置令牌一律 401**；
2. 反向代理层：`location = /metrics { deny all; }` 直接 403。

不采用“本机直连放行”，因为经反代后源地址永远是 `127.0.0.1`，等于对公网开放。

---

## 2. 指标清单

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `licensing_api_requests_24h` | gauge | 24 小时请求总量 |
| `licensing_api_success_24h` | gauge | 其中 `< 400` 的数量 |
| `licensing_api_success_ratio_24h` | gauge | 成功率（0~1） |
| `licensing_api_latency_p50_ms` / `p95_ms` | gauge | 延迟分位 |
| `licensing_licenses_total` | gauge | 未删除授权数 |
| `licensing_activations_active` | gauge | 活跃激活数 |
| `licensing_devices_total` | gauge | 设备总数 |
| `licensing_webhook_deliveries{status}` | gauge | 投递状态分布（succeeded/failed/dead/...） |
| `licensing_backup_jobs{status}` | gauge | 备份作业状态分布 |
| `licensing_info{env}` | gauge | 部署形态标记 |

采集示例（`/etc/prometheus/prometheus.yml`）：

```yaml
scrape_configs:
  - job_name: licensing-saas
    scheme: http
    metrics_path: /metrics
    static_configs:
      - targets: ["127.0.0.1:3100"]
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/metrics-token
```

本机尚未安装 Prometheus —— 指标端点已经可用，抓取端需要自行部署。

---

## 3. 日志

```bash
journalctl -u licensing-saas -f                          # 跟随
journalctl -u licensing-saas --since "-30min" | grep -iE "error|exception"
```

关键日志行（都有固定前缀，便于 grep）：

| 前缀 | 含义 |
| --- | --- |
| `[boot] env=... 配置检查通过` | 启动自检结果；不通过时生产会拒绝启动 |
| `[webhook] dispatcher started` | 投递器已启动 |
| `[webhook] claimed=N ok=… retry=… dead=…` | 单轮投递统计 |
| `[backup] scheduler started` | 备份调度器已启动 |
| `[backup] policy=… backup=… status=… targets=N` | 一次策略执行结果 |
| `[backup][alert]` | 备份失败/配置缺失/磁盘不足告警 |
| `[boot] 环境配置检查未通过` | 非生产环境只是告警，生产直接退出 |

日志轮转由 systemd-journald 管理（默认按容量滚动）。如需长期留存，配置
`/etc/systemd/journald.conf` 的 `Storage=persistent` 与 `SystemMaxUse=`。

---

## 4. 告警分级（18.3）

| 级别 | 触发条件 | 通道 | 处置 |
| --- | --- | --- | --- |
| P0 | 数据库不可用；签名私钥疑似泄漏；备份连续失败且无可用异地副本；跨租户数据泄露 | 立即通知（电话/IM）+ 事件响应 | 见 `operations.md` §3 |
| P1 | `/health/ready` 连续 3 次失败；公开 API 5xx > 1%；登录失败率突增 5 倍 | IM + 邮件 | 30 分钟内介入 |
| P2 | 单个备份目标失败；Webhook dead 增多；磁盘 > 80%；P95 翻倍 | 邮件/工单 | 次工作日处理 |

**当前已实现的告警出口**：
- 备份失败/配置缺失/磁盘不足 → 写 `audit_logs`（`backup.job_failed` / `backup.schedule_skipped`）
  + `console.error("[backup][alert] ...")` + 可选 `BACKUP_ALERT_WEBHOOK_URL` 外发；
- 其余指标告警需要 Prometheus Alertmanager 或等价系统基于 §2 的指标自行配置。

**尚未实现**：登录异常告警、跨租户越权实时告警、Webhook 成功率告警。不要假设有。

---

## 5. 排障路径

```text
用户报“验证失败”
├─ /health/ready 不健康？
│   ├─ database 有值 → 查 PG 容器与连接数
│   └─ signing_keys 有值 → 查 signing_keys 是否有 active 行、.keys-prod 是否可读
├─ /metrics 成功率低？
│   ├─ 429 多 → 限流命中，看 RateLimit-* 与 public-rate-limits.ts
│   ├─ 401 多 → X-Client-ID 与环境是否匹配（sandbox/production 凭证不通用）
│   └─ 5xx 多 → journalctl 找 stack，注意 SSRF 拦截会以 blocked_url: 记录
└─ 单条授权失败
    ├─ LICENSE_INVALID → 授权码错，或 pepper 版本不匹配（看 hash_key_version）
    ├─ DEVICE_LIMIT_EXCEEDED → 设备配额满，后台解绑或升配额
    └─ LICENSE_EXPIRED/SUSPENDED → 看 effective_status 与时间窗
```
