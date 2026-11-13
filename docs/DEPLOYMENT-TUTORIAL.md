# 授权系统部署教程（从 GitHub 全新部署到上线）

> 本教程只讲一条路：**一台全新服务器 + 从 GitHub 拉代码 + 全新数据上线**。
> 这是 2026-11-13 在一台 Debian 12 小机器（2 vCPU / 2 GiB 内存）上真实跑通的流程，
> 命令与输出都是实测的。从零到能登录后台约 15–30 分钟，主要耗时在装依赖与构建。
>
> 另外两份文档的分工：
>
> - [`DEPLOY-v15.md`](DEPLOY-v15.md)：迁移/恢复 dump 的路线、每个参数的深挖、完整排障表——当参考手册查。
> - [`v15-runbook.md`](v15-runbook.md)：上线之后的日常运维。
>
> **哪些能照抄、哪些必须换**（与 DEPLOY-v15 同一口径）：
>
> | 类别 | 处理方式 |
> | --- | --- |
> | 目录结构、命令、nginx 配置骨架、验证命令 | **照抄** |
> | 域名、服务器 IP | **换成你自己的** |
> | 管理员口令 | **部署时自备强口令**，绝不写进仓库、文档与聊天记录 |
> | 4 把密钥、数据库口令 | **必须在服务器上现场生成**，绝不复制任何现成值 |

部署完成后的形态：

| 组件 | 形态 | 监听 |
| --- | --- | --- |
| 授权系统应用 | systemd 服务 `licensing-saas`（仓库自带脚本安装） | `127.0.0.1:3100`（只绑回环） |
| PostgreSQL 16 | Docker 容器 `licensing-pg` | `127.0.0.1:55432`（只绑回环） |
| nginx | 反向代理 | `80`（有域名后加 `443`） |

---

## 0. 准备清单

- 一台 Debian 12（或同系）服务器，root 或 sudo 权限。配置下限：2 vCPU / 2 GiB 内存
  （内存小于 4 GiB 时确认有 swap，今天这台是 2 GiB + 10 GiB swap，构建能过但慢）/ 磁盘 20 GiB 以上。
- 能访问 GitHub（克隆仓库）与软件源（装 Node、Docker、nginx）。
- 一个管理员口令（≥12 位、含大小写/数字/符号，过应用自带口令策略即可），部署第 5 步用。
- 域名（可选，随时后补）：没有域名也能先用 IP 把站点跑起来预览，HTTPS 等域名到位再配（第 8 步）。

---

## 1. 机器初始化

```bash
apt-get update && apt-get install -y git curl openssl
```

### 1.1 Node.js 22（宿主机要装，部署脚本在本机跑构建）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v   # 期望 v22.x
```

### 1.2 Docker（跑 PostgreSQL 容器）

```bash
docker --version || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

### 1.3 防火墙与时区

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS（先放行，配证书时直接用）
ufw enable

timedatectl set-timezone Asia/Shanghai
```

> SSH 爆破在这类公网机器上几分钟内就会出现，建议再装 fail2ban 并启用 sshd jail：
> `apt-get install -y fail2ban && systemctl enable --now fail2ban`。

---

## 2. 拉取代码

```bash
mkdir -p /opt/licensing
git clone https://github.com/liang0222/Authorization-Management.git /opt/licensing/app
cd /opt/licensing/app
git log --oneline -1   # 确认在预期的提交上
```

> 没有 GitHub 直连时，用 git bundle 在能联网的机器上打包再搬运，校验 sha256 后
> `git clone <bundle>`，流程与校验方法见 [`DEPLOY-v15.md`](DEPLOY-v15.md) §2.2。

---

## 3. 写生产环境文件（先于部署脚本）

部署脚本会生成 `/etc/licensing-saas/production.env`，但它的**默认数据库口令是开发值**
`licensing_dev_pw`——生产不能用。所以先手工把这份文件写好（脚本发现文件已存在就会沿用），
密钥全部在服务器上现场生成、不经任何聊天与文档：

```bash
mkdir -p /etc/licensing-saas && chmod 750 /etc/licensing-saas
gen() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '='; }
DBPW=$(openssl rand -hex 24)
cat > /etc/licensing-saas/production.env <<EOF
DEPLOYMENT_ENV=production
LICENSE_DB_URL=postgresql://licensing:${DBPW}@127.0.0.1:55432/licensing?schema=public
SIGNING_KEY_DIR=.keys-prod
BACKUP_LOCAL_DIR=.backups-prod
APP_BASE_URL=http://127.0.0.1:3100
ASSERTION_AUDIENCE=license-api
DEV_MAIL_SINK=false

SESSION_SECRET=$(gen 32)
SECRETBOX_KEY=$(gen 32)
BACKUP_ENCRYPTION_KEY=$(gen 32)
LICENSE_HMAC_PEPPER=$(gen 32)
LICENSE_HMAC_PEPPER_VERSION=v2
LICENSE_HMAC_PEPPER_LEGACY=dev-only-license-hmac-pepper-please-change-in-production
LICENSE_HMAC_PEPPER_LEGACY_VERSION=v1
METRICS_TOKEN=$(gen 24)

PUBLIC_API_BASE_URL=
PUBLIC_SANDBOX_API_BASE_URL=
EOF
chmod 600 /etc/licensing-saas/production.env
```

逐项说明（只列容易填错的）：

| 变量 | 说明 |
| --- | --- |
| `LICENSE_DB_URL` | 端口 `55432` 与第 4 步脚本创建的容器一致；口令就是上面生成的 `DBPW`，脚本会从这串里解析出口令去建容器 |
| `SIGNING_KEY_DIR=.keys-prod` | 签名私钥目录（相对代码目录）。生产必须用独立目录，不能用默认 `.keys`（自检会 FAIL） |
| `APP_BASE_URL` | 先填内网地址；第 8 步对外发布时改成正式地址并重启服务 |
| `LICENSE_HMAC_PEPPER_LEGACY` | v1 兼容行：给老版本签发的授权码留的校验通道，全新部署没有 v1 数据，保留模板原样即可 |
| `DEV_MAIL_SINK=false` | 生产必须 false，否则邮件被吞进日志不真发 |

---

## 4. 一键部署

```bash
cd /opt/licensing/app
./scripts/deploy-bootstrap.sh --with-docker-pg
```

它按顺序做十件事：环境预检（root / Node ≥ 22）→ 沿用第 3 步的 env → 起 PostgreSQL 容器
→（无 dump 时跳过恢复）→ `npm ci` + 生成 Prisma Client → 跑全部迁移 → 检查/修复签名密钥
→ 生产构建 → 安装并启动 systemd 单元 → 真验证（探活接口逐项打）。

两个实测会遇到的情况：

1. **「PG 30 秒内没就绪」然后脚本退出**：小机器上首次拉镜像 + 初始化数据库超过脚本的
   30 秒等待窗口。不是故障——`docker ps` 确认容器在跑、`docker exec licensing-pg pg_isready`
   返回 `accepting connections` 后，**直接重跑同一条命令**即可，脚本是幂等的，会接着往下走。
2. **第 10 步真验证里 `/health/ready` 是 503、`signing_keys` 是 `no_active_signing_key`**：
   这是全新部署的**预期中间状态**——库里还没有任何签名密钥。下一步初始化数据后自动变 200。

构建很吃内存：2 GiB 机器上靠 swap 能过（实测编译约 30 秒 + 类型检查约 1 分钟）。
若构建 OOM 被杀，先确认 swap 在（`free -h`），再重跑脚本。


---

## 5. 初始化数据：干净首启（只建管理员，不灌演示数据）

```bash
cd /opt/licensing/app
set -a; . /etc/licensing-saas/production.env; set +a
ALLOW_DEMO_SEED=true SEED_MODE=core SEED_CORE_ADMIN_PASSWORD='<你的管理员口令>' npm run db:seed
```

- 为什么还要 `ALLOW_DEMO_SEED=true`：seed 有生产护栏——识别到生产身份默认拒绝执行，
  这是防误灌的闸，不是 bug。显式给它，是你在明知后果的情况下放行这一次。
- 干净首启的默认值（都可经环境变量覆盖）：

  | 项 | 默认值 | 覆盖变量 |
  | --- | --- | --- |
  | 组织名 | 子铭科技有限公司 | `SEED_CORE_ORG_NAME` |
  | 组织 slug | `ziming` | `SEED_CORE_ORG_SLUG` |
  | 管理员邮箱 | `admin@zming.de` | `SEED_CORE_ADMIN_EMAIL` |
  | 管理员显示名 | `Admin` | `SEED_CORE_ADMIN_NAME` |

- 口令**没有默认值**：`SEED_CORE_ADMIN_PASSWORD` 必填且必须过口令策略，不合规
  （含误用演示域名 `@xinglan.dev`、演示显示名）在清空数据**之前**就会被拒绝执行。
- 它只建：1 个组织、1 个管理员（owner 角色）、签名密钥、4 个产品与 20 个套餐骨架、
  产品凭证。**不建**任何客户、授权、激活、Webhook 与日志——后台打开就是干净的。

期望输出（一行汇总）：

```
干净首启完成：1 个组织（子铭科技有限公司）、1 个管理员（admin@zming.de）、4 个产品与套餐骨架、签名密钥已生成；未灌演示客户/授权/激活/Webhook/日志。
```

复核一遍库里只有骨架：

```bash
docker exec licensing-pg psql -U licensing -d licensing -c \
  "select (select count(*) from users) 管理员, (select count(*) from customers) 客户, (select count(*) from licenses) 授权;"
# 期望：管理员 1、客户 0、授权 0
```

> 开发/演示才用全量种子（`npm run db:seed` 不带 `SEED_MODE`）：它灌 14 个演示客户、
> 240 份授权和三个演示账号（`owner@`/`ops@`/`audit@xinglan.dev`，口令是公开的
> `License#2026`）。**生产不要用**——要用也必须随后把三个账号的邮箱与显示名一起改掉
> 再改口令，原因与 SQL 在 [`DEPLOY-v15.md`](DEPLOY-v15.md) §4.2。

---

## 6. 启动前自检：check:prod-env

```bash
cd /opt/licensing/app
npm run check:prod-env -- --env-file /etc/licensing-saas/production.env
```

九项逐项输出 PASS/FAIL（只报结论，绝不打印密钥值）。此时**唯一允许 FAIL 的是
`APP_BASE_URL`**（还不是 https，第 8 步配完域名后自动消除）；其余八项——四把密钥非默认值、
`DEPLOYMENT_ENV=production`、`DEV_MAIL_SINK=false`、`SIGNING_KEY_DIR` 独立、数据库口令
非开发值——必须全 PASS，任何一项 FAIL 先修 env 再往下走。

---

## 7. 验证服务真的活着

```bash
systemctl is-active licensing-saas        # 期望 active
curl -s http://127.0.0.1:3100/health/live   # 期望 {"status":"ok",...} 一类 200 响应
curl -s http://127.0.0.1:3100/health/ready  # 期望 {"status":"ready","checks":{"database":null,"signing_keys":null}}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/login   # 期望 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/        # 期望 307（跳 /app/dashboard，设计如此）
```

`ready` 不是 200 时，看 `checks` 字段对症：

| checks 值 | 含义 | 处理 |
| --- | --- | --- |
| `signing_keys: "no_active_signing_key"` | 还没初始化数据 | 做第 5 步 |
| `signing_keys: "signing_key_unreadable"` | 库里有密钥行、磁盘上没对应 `.pem` | 多半是灌错库或密钥目录配错；先查 `SIGNING_KEY_DIR`，别急着跑修复脚本 |
| `database` 非 null | 连不上库 | 查容器 `docker ps`、连接串端口与口令 |

启动被拦时看日志：`journalctl -u licensing-saas -n 50 --no-pager`。
生产启动闸门会把不合规项逐条列出来（演示账号、默认密钥等），照单修即可——
注意演示账号是按**邮箱域名 + 显示名**双路识别的，只改邮箱不够，显示名也要换。

---

## 8. 对外发布

### 8.1 先用 IP 预览（无域名时）

```bash
apt-get install -y nginx
cat > /etc/nginx/sites-available/default <<'EOF'
server {
    listen 80 default_server;
    server_name _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
nginx -t && systemctl enable --now nginx
sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=http://<服务器IP>|' /etc/licensing-saas/production.env
systemctl restart licensing-saas
```

浏览器打开 `http://<服务器IP>/login` 能登录即通。注意这是 **http 明文**，只作预览，
正式使用务必走 8.2。**不要在 nginx 里再加 `X-Frame-Options`**：应用层已经下发 `DENY`，
两处都加会在响应里出现两个同名头，浏览器行为不可预期。

### 8.2 域名 + HTTPS（正式形态）

1. 在域名服务商处加 A 记录：`<子域名>`（如 `license.zming.de`）→ 服务器 IP，等解析生效
   （`dig +short <子域名>` 能返回 IP）。
2. 签证书：

   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d <子域名>
   ```

3. 把 `APP_BASE_URL` 切到 https 并重启：

   ```bash
   sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=https://<子域名>|' /etc/licensing-saas/production.env
   systemctl restart licensing-saas
   npm run check:prod-env -- --env-file /etc/licensing-saas/production.env   # 期望 9/9 PASS
   ```


---

## 9. 上线验收清单（逐项打勾，全绿才算上线）

- [ ] `systemctl is-active licensing-saas` = active，`health/ready` 200
- [ ] `check:prod-env` 9/9 PASS（IP 预览阶段允许 `APP_BASE_URL` 一项 FAIL）
- [ ] 用管理员账号从公网登录后台成功；组织名、产品、套餐显示正确
- [ ] 客户 / 授权 / 激活设备列表为空（干净首启的标志；有演示数据说明灌错了种子）
- [ ] 后台「开发者中心 → API 接入」点连通性自检，通过
- [ ] **真跑一遍业务链**：新建一个测试客户 → 签发一份授权 → 用 SDK 示例或真实客户端
      完成挑战激活 → 心跳成功（令牌轮换）→ 后台能看到设备 → 解绑。
      `ready` 200 只证明私钥可读，**不证明签出来的授权能验过**，这一步不能省；
      验收用的测试客户/授权留不留随意，留的话备注写明验收用途
- [ ] 备份：后台「系统设置 → 备份与灾备」至少配一个本地目标并手动跑一次作业成功；
      异地目标建议同期配上（见第 10 步的明文规则）
- [ ] 把 `.keys-prod/` 目录（含 `credentials`）离线备份一份到安全介质——
      签名私钥丢了，存量授权全部无法续验
- [ ] 确认没有演示账号残留：库里 `users` 表只有真实账号（干净首启天然满足）

---

## 10. 日常运维速查

```bash
systemctl restart licensing-saas                 # 重启应用（改 env 后必须）
journalctl -u licensing-saas -f                  # 跟日志
journalctl -u licensing-saas --since today       # 看今天
docker logs licensing-pg --tail 50               # 数据库日志
```

**更新到新版本**（先给库做快照，再动代码）：

```bash
docker exec licensing-pg pg_dump -U licensing -d licensing -Fc > /opt/licensing/pre-upgrade-$(date +%F).dump
cd /opt/licensing/app
git pull
npm ci && npx prisma generate
set -a; . /etc/licensing-saas/production.env; set +a
npx prisma migrate deploy
npm run build
systemctl restart licensing-saas
curl -s http://127.0.0.1:3100/health/ready       # 回到 ready 才算更新完成
```

回滚：代码 `git checkout <上一个提交>` 后重复构建+重启；数据回滚用部署/更新前的
`pg_dump` 快照恢复（恢复会先清 schema，完整步骤见 [`DEPLOY-v15.md`](DEPLOY-v15.md) §4.1）。

**备份目标的明文规则**：生产环境下 `http://` 且非回环的备份目标，光在目标上勾
`tls_verify=false` 还不够，必须同时在 env 里设 `ALLOW_INSECURE_BACKUP_HTTP=true`
才会保存与执行；缺一项，保存直接 400，执行期跳过并把作业标 `degraded`——
不会静默明文发送。能走 https 就走 https，明文只作过渡。

**可选：安全告警外发**。登录爆破与越权探测的告警默认只落审计与日志；在 env 里加
`ALERT_WEBHOOK_URL=<https 地址>` 可外发到你的告警通道（未设时回退
`BACKUP_ALERT_WEBHOOK_URL`）。

---

## 11. 排障速查

| 症状 | 多半是 | 处理 |
| --- | --- | --- |
| 部署脚本报「PG 30 秒内没就绪」退出 | 小机器首次初始化慢 | 容器就绪后重跑脚本（幂等），见第 4 步 |
| `ready` 503 + `no_active_signing_key` | 没初始化数据 | 第 5 步干净首启 |
| 服务反复重启，日志列「生产库里存在演示账号…」 | 全量种子的演示账号没改干净 | 邮箱与**显示名**一起换（§5 提示框里的 SQL），或改用干净首启重建 |
| `npm run db:seed` 直接退出码 1 | 生产护栏拦下 | 显式加 `ALLOW_DEMO_SEED=true`（确认打的是目标库再加） |
| seed 报 `SEED_MODE=core 配置不合规` | 口令弱 / 用了演示域名或演示显示名 | 按它列出的条目逐项改 |
| 登录返回 429 | 触发登录限流（8 次/5 分钟/IP） | 等 5 分钟；别脚本连打，爆破告警也会记一笔 |
| 构建被 Killed | 内存不足 | 确认 swap；或临时 `NODE_OPTIONS=--max-old-space-size=3072` 再构建 |
| `check:prod-env` 只剩 `APP_BASE_URL` FAIL | 还没配 https | 预期内，域名到位后按 8.2 消除 |
| 改了 env 不生效 | 没重启服务 | `systemctl restart licensing-saas`（env 由 systemd 启动时注入） |

更深的排障（恢复演练、密钥轮换、沙箱双实例）见 [`DEPLOY-v15.md`](DEPLOY-v15.md) §13
与 [`v15-runbook.md`](v15-runbook.md)。

---

## 附：一页版命令清单

```bash
# 1 机器：Node 22 + Docker + 防火墙（§1）
# 2 代码：git clone https://github.com/liang0222/Authorization-Management.git /opt/licensing/app
# 3 env ：手写 /etc/licensing-saas/production.env（密钥现场生成，chmod 600）（§3）
# 4 部署：./scripts/deploy-bootstrap.sh --with-docker-pg（§4）
# 5 首启：ALLOW_DEMO_SEED=true SEED_MODE=core SEED_CORE_ADMIN_PASSWORD=<口令> npm run db:seed（§5）
# 6 自检：npm run check:prod-env -- --env-file /etc/licensing-saas/production.env（§6）
# 7 验证：curl 127.0.0.1:3100/health/ready → ready（§7）
# 8 发布：nginx 反代 →（有域名）certbot + APP_BASE_URL 切 https → 自检 9/9（§8）
# 9 验收：§9 清单全绿，含真签发→激活→心跳一遍
```
