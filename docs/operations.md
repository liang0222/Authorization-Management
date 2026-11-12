# 运行维护与业务连续性

对应规格 23。发布、容量、事件响应与状态页的可执行版本；日常命令见
[`v15-runbook.md`](./v15-runbook.md)，监控指标见 [`observability.md`](./observability.md)。

---

## 1. 环境与发布管理（23.1）

| 环境 | 地址 | 数据库 | 密钥目录 | 用途 |
| --- | --- | --- | --- | --- |
| production | `127.0.0.1:3100`（反代 `<你的域名>`） | `licensing` | `.keys-prod` | 真实客户与授权 |
| sandbox | `127.0.0.1:3101` | `licensing_sandbox` | `.keys-sandbox` | 接入联调，数据与生产物理隔离 |
| development | 本机 `next dev` | 同上或本地库 | `.keys` | 开发 |

三个环境的凭证池由 `product_credentials.environment` 区分，跨环境调用一律按无效处理。

### 1.1 发布流程

```bash
# 1) 本地门禁（与 CI 一致）
npm run verify            # typecheck + openapi lint + unit test + build

# 2) 集成测试（需要可用的 PG 与服务）
npm run db:migrate && npm run db:seed
TEST_BASE_URL=http://127.0.0.1:3101 npx vitest run tests/integration

# 3) 打不可变标签（禁止用 latest 部署）
git tag -a v1.5.1 -m "v1.5.1"
git push --tags

# 4) 生产发布
sudo git -C /root/授权saas fetch --tags && sudo git -C /root/授权saas checkout v1.5.1
cd /root/授权saas && npm ci && npx prisma generate && npm run build
sudo systemctl restart licensing-saas
```

每次发布在 `CHANGELOG.md` 记录：版本、commit、迁移 ID、回滚方式。
数据库变更采用 expand/contract：先加列（可空/有默认）→ 双写 → 回填 → 再删旧列，
不可逆迁移必须先做一次备份并演练恢复。

### 1.2 回滚

| 场景 | 操作 |
| --- | --- |
| 代码有问题、迁移兼容 | `git checkout v1.5.0` → `npm ci` → `npm run build` → `systemctl restart licensing-saas` |
| 迁移不可逆 | 停服 → 用最近一次备份恢复到新库 → 改 `LICENSE_DB_URL` → 起旧版本 → 核对行数 |
| 密钥轮换出错 | 保留 `SECRETBOX_KEYS_LEGACY` / `LICENSE_HMAC_PEPPER_LEGACY` 即可回退读旧数据 |

---

## 2. 容量与成本（23.2）

需要持续关注的量（`/metrics` 已暴露其中大部分）：

- 数据库：连接数、库大小、慢查询、`api_request_logs` 增长速度；
- 存储：`.backups/` 与远端对象存储占用、备份增长趋势；
- 业务：活跃授权、活跃设备、公开 API 调用量；
- 主机：CPU、内存、磁盘、inode、容器重启次数。

**预警阈值（建议）**：磁盘使用率 > 80% 告警、> 90% 严重；备份连续 2 次失败告警；
`api_request_logs` 单日增长 > 500 万行时缩短保留期或归档。

**原始心跳不落库**：心跳只更新 `activations.last_heartbeat_at` 与聚合计数，
不逐条写事件表；`activation_events` 只记录状态变化（激活/解绑/暂停/撤销）。

---

## 3. 事件响应（23.3）

### 3.1 分级与响应时间

| 级别 | 判定 | 首次响应 | 处置目标 |
| --- | --- | --- | --- |
| P0 | 数据库不可用、签名私钥疑似泄漏、跨租户数据泄露、备份链路完全失效且无可用异地备份 | 15 分钟 | 4 小时内止损 |
| P1 | 公开 API 大面积 5xx、登录不可用、Webhook 全部失败 | 30 分钟 | 24 小时内恢复 |
| P2 | 单个目标备份失败、指标异常、个别客户问题 | 4 小时 | 3 个工作日 |

值班联系人：`[ONCALL_EMAIL]`（P0 同时电话通知值班人）。对外通告模板见 §3.4。

### 3.2 密钥泄漏处置（按顺序执行）

1. **止血**：把疑似泄漏的签名密钥置为 `revoked`
   （`PATCH /api/v1/admin/signing-keys/{id}`，`status=revoked`）。
   已有离线授权文件的验证会失败，这是预期代价。
2. **发布新密钥**：`POST /api/v1/admin/signing-keys` 新建并设为 `active`；
   新签发的授权自动使用新密钥。旧公钥保留在客户端用于验证既有授权（`retiring` 而非直接删）。
3. **轮换凭证**：`POST /api/v1/admin/credentials/{id}` 走「新建 → 验证新凭证可用 → 停用旧凭证」，
   不要先删旧的。
4. **轮换会话与封存密钥**：改 `SESSION_SECRET`（全员强制重新登录）、改 `SECRETBOX_KEY`
   并用 `npx tsx scripts/rotate-secrets.mts --apply` 重封存。
5. **轮换授权码 pepper**：新 pepper 写入 `LICENSE_HMAC_PEPPER`，旧值移到
   `LICENSE_HMAC_PEPPER_LEGACY`（版本环保证旧码仍可校验并就地重哈希）。
6. **强制登出**：改所有管理员密码，或在数据库执行
   `UPDATE admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL;`。
7. **取证与复盘**：导出 `audit_logs`（按时间窗）、`api_request_logs`、Webhook 投递记录；
   记录到事件文档，48 小时内出复盘。

### 3.3 数据库故障处置

```bash
systemctl status licensing-pg || docker ps --filter name=licensing-pg
curl -fsS http://127.0.0.1:3100/health/ready     # 看 database 组件
```

- 容器挂了：`docker start licensing-pg`，再查 `/health/ready`；
- 数据损坏：停服 → 取最近 `verified` 备份 → 解密 → `pg_restore` 到新库 → 行数对账 →
  切 `LICENSE_DB_URL` → 起服 → 抽样验证授权；
- RPO：未启用 WAL/PITR，最坏丢失“距上次成功备份”的数据（默认每日 03:00）；
- RTO：实测恢复演练约 2 秒（小库），生产按 30 分钟评估（含人工确认）。

### 3.4 客户通告模板

```
【故障通告】授权验证服务短时不可用

影响时间：2026-11-03 14:05 - 14:32（Asia/Shanghai）
影响范围：公开 API 验证与激活请求返回 5xx；已激活的客户端不受影响（本地缓存有效）
当前状态：已恢复，14:32 起成功率回到 99.9%
原因：数据库连接池耗尽，已扩容并加上连接上限
后续：本周内补充连接池监控告警，复盘报告可向 `[SUPPORT_EMAIL]` 索取
```

原则：只说事实与影响，不披露内部主机名、IP、架构细节、其他客户信息。

---

## 4. 状态页与维护公告（23.4，第二阶段）

现成可用的最小状态页：`/developers/status`（公开，只显示聚合数字：24h 请求量、成功率、P95）。
它读 `GET /api/v1/status`，不含任何租户或主机信息。

维护公告当前需要手工在页面文案中更新；**未实现**公告管理后台。这是已知缺口。

计划维护窗口建议放在业务低峰（`Asia/Shanghai` 02:00-05:00），提前 24 小时通告。

---

## 5. 日常任务清单

| 周期 | 任务 |
| --- | --- |
| 每日 | 看 `/health/ready`、备份作业是否 `succeeded`、`/metrics` 的成功率与 P95 |
| 每日（自动 04:30） | 数据保留清理已由 `licensing-saas-retention.timer` 执行；要复核先跑 `npx tsx scripts/retention-cleanup.mts`（dry-run） |
| 每周 | 检查 `webhook_deliveries` 的 dead 数量、磁盘余量、`audit_logs` 异常动作 |
| 每月 | 跑一次隔离恢复演练（`POST /admin/backups/jobs/{id}/restore-test`）、核对离线密钥副本 |
| 每季 | 轮换 `METRICS_TOKEN`、复核管理员权限与 MFA 状态、跑 `npm audit` |

**已内置的定时任务**：备份调度（`backup_policies.schedule_cron`，30s tick）、数据保留清理
（`licensing-saas-retention.timer`，每日 04:30）、Webhook 投递（5s 轮询）。

**仍未内置的定时任务**：月度恢复演练提醒、证书到期提醒。需要外部 cron 或人工执行，
不要假设系统会自动做。

---

## 6. 依赖漏洞处置（供应链）

### 6.1 扫描入口

| 场景 | 命令/位置 | 是否阻断 |
| --- | --- | --- |
| 本地生产依赖体检 | `npm run audit:prod` | 否，人工判断 |
| CI 生产依赖门禁 | `.github/workflows/ci.yml` 的 `supply-chain` job：`npm audit --omit=dev --audit-level=critical` | **critical 阻断合并** |
| CI 全量依赖报告 | 同一 job：`npm audit --audit-level=critical \|\| true` | 否，只打印 high/medium/low |

`supply-chain` 单独成 job 而不是挂在 `static` 末尾：审计依赖 npm registry 的网络与
漏洞库状态，和编译/单测的失败原因不同；独立 job 能让“代码坏了”和“依赖有洞”在
Checks 里一眼分开，也方便单独重跑。Node 基线保持 22。

### 6.2 处置时限

| 等级 | 时限 | 动作 |
| --- | --- | --- |
| critical | 48 小时内 | 升级到修复版本；确实无法升级时，写 `docs/security-exceptions.md` 走书面风险接受 |
| high | 一周内 | 排入最近一次迭代升级；不能升级的同样登记例外 |
| medium / low | 常规维护 | 随下一次依赖更新处理，不单独打断发布 |

“书面风险接受”必须包含：漏洞编号、影响组件、接受理由、补偿措施、到期日、负责人。
缺任意一项视为未接受；到期未复核的例外自动失效，必须重新评估或升级。

### 6.3 处理流程

1. 在 CI 的 `supply-chain` job 或本地 `npm run audit:prod` 看到告警；
2. 确认是否影响实际运行路径（仅 devDependency、未使用的可选依赖、无法触发的代码路径）；
3. 能升级就单独提依赖升级 PR，附 `npm audit` 前后对比；不要和业务改动混在一起；
4. 不能升级则登记例外，写清补偿措施（例如关闭相关功能、加网络层限制、缩短 token 生命周期）；
5. 修复/例外生效后重跑 `npm run audit:prod` 与 CI，确认 critical 清零或已登记；
6. 例外到期前一周由负责人复核：升级、续期（需重新审批）或删除。

### 6.4 本轮范围说明

阶段 7 只建立扫描与流程，**不批量升级任何依赖**；实际升级另开 PR，避免把供应链变更
和 ESLint/CI 改动混在一个提交里。

以下两项是总提示词明确的本轮范围外事项，仅登记、不在阶段 7 实施：

- 列表分页从 offset 迁移到 keyset（`cursor.ts` 本轮不动）；
- 限流从 PostgreSQL/进程内计数迁移到 Redis（本轮不引入 Redis）。

需要做时单独评估，不要顺手塞进安全修复 PR。
