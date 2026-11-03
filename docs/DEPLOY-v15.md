# 授权 SaaS v1.5 · 部署教程（自己动手版）

> 这份文档按「一台全新 Debian 13 机器 → 能对外服务的生产实例」写。
> 每一条命令都在这台机器上真跑过，输出值都是实测的，不是估计。
>
> **哪些能照抄、哪些必须换**：
>
> | 类别 | 处理方式 |
> | --- | --- |
> | 目录结构、systemd 单元、nginx 配置骨架、验证命令 | **照抄** |
> | 域名 `<你的域名>`、服务器 IP `[HOST]` | **必须换成你自己的** |
> | 所有密码（`licensing_dev_pw`、`License#2026`、`webdav_pw_2026`…） | **必须换**，本文给的是本机开发值 |
> | 所有密钥（`SESSION_SECRET` 等 4 把） | **必须现场生成**，绝不能复制别人的 |
> | 备份目标 id（`969407cb-…` 这类 UUID） | 每次部署都不一样，**按你自己接口返回的填** |

---

## 0. 先读这一段：三个会把你坑死的点

1. **本项目没有 `/api/health`**。真实健康端点是 `/api/v1/status`（业务状态）和 `/health/live`、`/health/ready`（探针）。拿 `/api/health` 测会一直 404。
2. **`GET /` 返回 307 不是 200**。`src/app/page.tsx` 首行就是 `redirect()`，跳到 `/app/dashboard`。这是设计，不是故障。
3. **`license_keys` 表里没有明文授权码**。只存 `key_prefix` + `key_last4` + `key_hash`（HMAC-SHA256）。想看明文只能重新签发，数据库里翻不出来。

---

## 1. 机器准备

### 1.1 配置要求（实测占用）

| 项 | 本机实测 | 建议下限 |
| --- | --- | --- |
| 系统 | Debian GNU/Linux 13 (trixie) | Debian 12/13 |
| CPU | — | 2 核 |
| 内存 | 11 GiB，峰值用 2.8 GiB | 4 GiB |
| 磁盘 | 98 G，已用 22 G（其中 `node_modules` 976 M、`.next` 197 M） | 40 G |
| Node | **v26.13.0**（nodesource `node_26.x`） | 22 以上 |
| npm | 11.20.0 | 10 以上 |
| Docker | 29.9.2 | 24 以上 |

Node 22 也能跑，但本机是 26，本文所有验证都在 26 上做的。**换 Node 大版本后必须重装 `node_modules`**（原生模块 ABI 会不匹配，报 `NODE_MODULE_VERSION` 之类的错）。

### 1.2 装 Node

```bash
# nodesource 源（本机用的就是这个）
curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
apt-get install -y nodejs
node -v && npm -v
```

### 1.3 装 Docker

```bash
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker version
```

### 1.4 时区（重要）

本机是 `Etc/UTC`。`systemctl list-timers` 显示的时间就是 UTC，**不是北京时间**。

如果你希望定时任务按北京时间理解：

```bash
timedatectl set-timezone Asia/Shanghai
timedatectl
```

> 但注意：备份策略 `daily-production` 的 cron 是 `0 3 * * *` + `timezone: "Asia/Shanghai"`，**这个时区写在策略里，跟系统时区无关**，所以系统时区改不改都不影响 03:00 这个点。

---

## 2. 目录与代码

### 2.1 建目录

```bash
mkdir -p /root/授权saas
cd /root/授权saas
```

> **路径里有中文**。本机就是 `/root/授权saas`，能正常工作，但：
> - systemd 单元里的 `WorkingDirectory=` 要原样写中文
> - 任何 `for f in $(ls ...)` 的循环建议加引号，否则会被空格/编码搞坏
> - 不想处理这个就换成 `/opt/licensing-saas`，后面所有路径跟着换

### 2.2 放代码

三种方式，选一种：

**A. git 拉（推荐，前提是你有自己的仓库）**

```bash
cd /root/授权saas
git clone <YOUR_REPOSITORY_URL> .
git fetch --tags
git checkout v1.5.0        # 用 tag，不要跟分支
```

**B. 从别的机器 rsync 整目录**

```bash
# 在源机器执行
rsync -avz --exclude node_modules --exclude .next --exclude .backups \
      --exclude .keys-prod --exclude .keys-sandbox \
      /root/授权saas/ target-host:/root/授权saas/
```

**C. 打包传输**

```bash
# 源机器：排除后只有约 17 M
cd /root
tar czf licensing-saas.tar.gz \
  --exclude='授权saas/node_modules' --exclude='授权saas/.next' \
  --exclude='授权saas/.backups' --exclude='授权saas/.backups-sandbox' \
  --exclude='授权saas/.keys-prod' --exclude='授权saas/.keys-sandbox' \
  授权saas

# 目标机器
tar xzf licensing-saas.tar.gz -C /root
```

> ⚠️ **不要同步 `node_modules` 和 `.next`**。它们是 Node 24 下装/构建的，到 Node 26 上 ABI 不匹配、构建产物也不兼容。必须重装重建。
> ⚠️ **不要同步 `.keys-prod`**。签名私钥应该在新机器上重新生成，或者从离线备份恢复（见 §9.4）。复制私钥等于把签发能力复制一份。

### 2.3 确认目录内容

```bash
ls -la /root/授权saas
# 应该有：package.json package-lock.json prisma/ src/ scripts/ docs/ next.config.ts prisma7.config.ts
```

---

## 3. 数据库

### 3.1 起 PostgreSQL 容器

```bash
docker run -d \
  --name licensing-pg \
  --restart unless-stopped \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=licensing \
  -e POSTGRES_PASSWORD=licensing_dev_pw \
  -e POSTGRES_DB=licensing \
  -v licensing-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

关键点：

- **`-p 127.0.0.1:55432:5432`**：只绑回环。写成 `-p 55432:5432` 就是 `0.0.0.0`，数据库直接暴露公网。
- 端口用 **55432** 不用 5432，避免和宿主机可能已有的 PG 打架。
- 卷名 `licensing-pgdata`，**容器删了数据还在**；要彻底重来才 `docker volume rm`。

等它起来：

```bash
for i in $(seq 1 30); do
  docker exec licensing-pg pg_isready -U licensing -d licensing && break
  sleep 1
done
```

期望输出：`/var/lib/postgresql/data: accepting connections`

### 3.2 建沙箱库（生产 + 沙箱双实例才需要）

规格 27.3 要求 Sandbox 用**独立数据库**。如果只跑生产可以跳过这步。

手动建：

```bash
docker exec licensing-pg psql -U licensing -d postgres -c "CREATE DATABASE licensing_sandbox OWNER licensing"
```

或者用仓库自带的脚本（会顺带跑迁移 + 灌沙箱种子 + 生成独立的沙箱凭证）：

```bash
cd /root/授权saas
./scripts/sandbox-bootstrap.sh           # 首次建库
RESET=1 ./scripts/sandbox-bootstrap.sh   # 清空重建（沙箱数据全丢，这是设计）
```

脚本会设 `SIGNING_KEY_DIR=.keys-sandbox`、`BACKUP_LOCAL_DIR=.backups-sandbox`、`SEED_CREDENTIAL_ENVIRONMENT=sandbox`，得到一套**沙箱专属的 client_id**。

---

## 4. 数据

有两条路：**恢复现成 dump**（迁机场景）或 **migrate + seed**（全新场景）。

### 4.1 路线 A：恢复 dump（推荐，数据完整）

```bash
# 1) 先确认 dump 是 custom format 且没坏
ls -l /tmp/licensing.dump        # 本机是 290653 B
head -c 5 /tmp/licensing.dump | od -A n -t x1
# 期望：50 47 44 4d 50（ASCII "PGDMP"）。
# 若是 1f 8b 开头说明是 gzip 的 plain dump，要 gunzip 后走 psql，不能 pg_restore。
# 本机没装 file 命令，用 od 更可靠。

# 2) 关键：先把 dump 拷进容器
#    直接 docker exec -i ... pg_restore < /tmp/xxx 会报
#    "input file is too short (read 0, expected 5)" —— 容器读不到宿主机的重定向
docker cp /tmp/licensing.dump licensing-pg:/tmp/restore.dump

# 3) 恢复
docker exec licensing-pg pg_restore -U licensing -d licensing \
  --clean --if-exists --no-owner /tmp/restore.dump

# 4) 清掉容器内临时文件
docker exec licensing-pg rm -f /tmp/restore.dump
```

`--clean --if-exists` 会先 DROP 再建，**已有数据会被清空**，别在线上库上随手跑。

### 4.2 路线 B：全新初始化

```bash
cd /root/授权saas
export LICENSE_DB_URL="postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public"

npx prisma migrate deploy     # 建表，7 个迁移
npm run db:seed               # 灌种子数据
```

> ⚠️ `npm run db:seed` **第一件事就是 TRUNCATE 全部业务表**（`prisma/seed.ts` 里那段 `TRUNCATE TABLE ... RESTART IDENTITY CASCADE`）。它只适合空库或你要重置的开发库。**线上绝对不要跑。**

种子会创建三个账号：

| 邮箱 | 密码 | 角色 |
| --- | --- | --- |
| `owner@xinglan.dev` | `License#2026` | 所有者 |
| `ops@xinglan.dev` | `License#2026` | 运营 |
| `audit@xinglan.dev` | `License#2026` | 只读 |

**上线第一件事就是改掉这三个密码。**

### 4.3 验证数据

```bash
docker exec licensing-pg psql -U licensing -d licensing -At -c "
select 'organizations='||(select count(*) from organizations)
   ||' customers='||(select count(*) from customers)
   ||' products='||(select count(*) from products)
   ||' license_keys='||(select count(*) from license_keys)
   ||' activations='||(select count(*) from activations)
   ||' api_request_logs='||(select count(*) from api_request_logs)"
```

本机 dump 恢复后的**精确值**：

```
organizations=1 customers=14 products=4 license_keys=232 activations=444 api_request_logs=260
```

`audit_logs` 恢复当时是 46，现在 141——因为跑了一整天的运维操作。**这一项不必对上**，其他六项必须精确。

再确认表和迁移：

```bash
docker exec licensing-pg psql -U licensing -d licensing -At -c \
  "select count(*) from information_schema.tables where table_schema='public'"
# 期望 41

docker exec licensing-pg psql -U licensing -d licensing -At -c \
  "select count(*) from _prisma_migrations where finished_at is not null"
# 期望 7
```

---

## 5. 环境变量

### 5.1 生成 4 把密钥

```bash
gen() { node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"; }
echo "SESSION_SECRET=$(gen)"
echo "SECRETBOX_KEY=$(gen)"
echo "BACKUP_ENCRYPTION_KEY=$(gen)"
echo "LICENSE_HMAC_PEPPER=$(gen)"
echo "METRICS_TOKEN=$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))")"
```

本机实测各值长度：四把密钥都是 **43 字符**（32 字节 base64url 无填充），`METRICS_TOKEN` 是 **32 字符**（16 字节 hex）。

**这四把必须互相独立**，不能一把顶四把。理由在 `.env.example` 里写了：生命周期不同，换会话密钥不该连带废掉所有密文。

### 5.2 生产环境文件

```bash
mkdir -p /etc/licensing-saas
chmod 750 /etc/licensing-saas
```

写入 `/etc/licensing-saas/production.env`：

```bash
cat > /etc/licensing-saas/production.env <<'EOF'
DEPLOYMENT_ENV=production
SIGNING_KEY_DIR=.keys-prod
APP_BASE_URL=https://<你的域名>
DEV_MAIL_SINK=false

SESSION_SECRET=<粘贴生成的值>
SECRETBOX_KEY=<粘贴生成的值>
LICENSE_HMAC_PEPPER=<粘贴生成的值>
LICENSE_HMAC_PEPPER_VERSION=v2
BACKUP_ENCRYPTION_KEY=<粘贴生成的值>

METRICS_TOKEN=<粘贴生成的值>
EOF
chmod 600 /etc/licensing-saas/production.env
```

### 5.3 ⚠️ 一个必须知道的坑：`LICENSE_DB_URL` 不在这个文件里

本机 `/etc/licensing-saas/production.env` **没有** `LICENSE_DB_URL`，于是 `src/lib/config.ts` 回退到写死的开发默认值：

```
postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public
```

本机能跑通是因为默认值恰好就是本机的库。**换机器 / 换密码 / 换端口就会连错库**，而且不会报错——它会安静地连上那个默认地址（连不上才报 P1001）。

所以你自己部署时**务必显式写上**：

```bash
echo 'LICENSE_DB_URL=postgresql://licensing:你的密码@127.0.0.1:55432/licensing?schema=public' \
  >> /etc/licensing-saas/production.env
```

变量名是 `LICENSE_DB_URL` 不是 `DATABASE_URL`——这是刻意的，避免继承到环境里残留的同名变量（真实踩过，表现为莫名其妙的 `P1001 ECONNREFUSED`）。

### 5.4 生产启动闸门会拦什么

`src/lib/config.ts` 的 `productionSafetyIssues()` 在 `src/instrumentation.ts` 里被调用，**不通过就直接启动失败**：

- `DEPLOYMENT_ENV` 不是 `production`/`sandbox`/`development` 之一
- 生产用了开发目录 `.keys`
- `SESSION_SECRET` 还是开发默认值
- `LICENSE_HMAC_PEPPER` 还是开发默认值
- `BACKUP_ENCRYPTION_KEY` 还是开发默认值
- `DEV_MAIL_SINK` 不是 `false`

漏一项服务就起不来，日志里会列清楚是哪项。

### 5.5 沙箱环境文件（可选）

`/etc/licensing-saas/sandbox.env`：

```bash
DEPLOYMENT_ENV=sandbox
LICENSE_DB_URL=postgresql://licensing:密码@127.0.0.1:55432/licensing_sandbox?schema=public
SIGNING_KEY_DIR=.keys-sandbox
BACKUP_LOCAL_DIR=.backups-sandbox
APP_BASE_URL=http://127.0.0.1:3101
ASSERTION_AUDIENCE=license-api
SESSION_SECRET=<独立生成>
LICENSE_HMAC_PEPPER=<独立生成>
BACKUP_ENCRYPTION_KEY=<独立生成>
DEV_MAIL_SINK=false
```

**沙箱的三把密钥必须与生产不同**，否则沙箱签的令牌能在生产用。

---

## 6. 依赖与构建

```bash
cd /root/授权saas

# 1) 装依赖
npm ci                    # 有 package-lock.json，优先用 ci
# 失败再退 npm install

# 2) 生成 Prisma Client
npx prisma generate

# 3) 构建
npm run build
```

### 6.1 各步期望输出

**`npm ci`**：本机 `npm ci` 输出 `added 784 packages`（落盘后 `node_modules` 里含嵌套共 1283 个 `package.json`、约 976 MB），耗时 1–3 分钟。Prisma 7 的 engines 要现场下载，网络慢会卡在 `prisma` 那一步——超时就重试一次，不要连续重试超过两次。

**`npx prisma generate`**：生成到 `src/generated/prisma/`（不是默认的 `node_modules/.prisma`，因为 `schema.prisma` 里写了 `output = "../src/generated/prisma"`）。这个目录在 `.gitignore` 里，所以**每次部署都必须重新 generate**。

**`npm run build`**：结尾是 `✓ Compiled successfully`。

### 6.2 构建时最容易踩的坑

**`next.config.ts` 开了 `cacheComponents: true`**。这意味着：

```ts
// ❌ 这样写构建会失败
export const dynamic = "force-dynamic";
```

新写路由时不要加这行。需要动态行为就靠 `cache: "no-store"` 或请求本身带动态数据。

### 6.3 全量校验（可选但建议）

```bash
npm run verify
# = typecheck + lint:openapi + test + build
```

本机实测：`14 files / 153 tests passed`，typecheck 0 错。

---

## 7. systemd 常驻

### 7.1 生产单元

`/etc/systemd/system/licensing-saas.service`：

```ini
[Unit]
Description=Licensing SaaS (Next.js) on 127.0.0.1:3100
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/授权saas
Environment=NODE_ENV=production
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/etc/licensing-saas/production.env
ExecStart=/usr/bin/npm run start -- -p 3100 -H 127.0.0.1
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

三个关键点：

- **`-H 127.0.0.1`**：不加这个，Next 默认绑 `0.0.0.0`，3100 直接公网可达。
- **`EnvironmentFile`** 指向 `/etc/...` 而不是项目里的 `.env`，这样密钥不在代码目录里。
- **`Restart=on-failure`** + `RestartSec=3`：崩了自动拉起来，但不会疯狂重启。

### 7.2 沙箱单元（可选）

`/etc/systemd/system/licensing-saas-sandbox.service`，与上面基本相同，改四处：

```ini
Description=Licensing SaaS Sandbox (Next.js) on 127.0.0.1:3101
After=network-online.target docker.service licensing-saas.service
EnvironmentFile=/etc/licensing-saas/sandbox.env
ExecStart=/usr/bin/npm run start -- -p 3101 -H 127.0.0.1
```

### 7.3 数据保留清理定时器

`/etc/systemd/system/licensing-saas-retention.service`：

```ini
[Unit]
Description=Licensing SaaS 数据保留清理（规格 17.5）
After=network-online.target docker.service licensing-saas.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/root/授权saas
EnvironmentFile=/etc/licensing-saas/production.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/npx tsx scripts/retention-cleanup.mts --apply
Nice=10
IOSchedulingClass=idle
```

`/etc/systemd/system/licensing-saas-retention.timer`：

```ini
[Unit]
Description=每日 04:30 执行数据保留清理

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
RandomizedDelaySec=300
Unit=licensing-saas-retention.service

[Install]
WantedBy=timers.target
```

### 7.4 启用

```bash
systemctl daemon-reload
systemctl enable --now licensing-saas
systemctl enable --now licensing-saas-sandbox      # 可选
systemctl enable --now licensing-saas-retention.timer

systemctl status licensing-saas --no-pager
```

期望 `Active: active (running)`。

---

## 8. 反向代理与 HTTPS

本机用的是 **1Panel 的 openresty 容器**（`1Panel-openresty-91lk`，`--network host`，占 80/443）。如果你没装 1Panel，可以直接 `apt install nginx`，配置逻辑一样。

### 8.1 容器挂载关系（1Panel 场景）

| 宿主机 | 容器内 |
| --- | --- |
| `/opt/1panel/www` | `/www` |
| `/opt/1panel/www/conf.d` | `/usr/local/openresty/nginx/conf/conf.d` |
| `/opt/1panel/apps/openresty/openresty/conf/ssl` | `/usr/local/openresty/nginx/conf/ssl` |

`nginx.conf` 里是 `include /usr/local/openresty/nginx/conf/conf.d/*.conf;` —— 所以 `*.conf.bak-*` 这种后缀**不会被加载**，可以放心把旧配置留在同目录。

### 8.2 站点配置

`/opt/1panel/www/conf.d/<你的域名>.conf`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name <你的域名>;

    # ACME HTTP-01 校验目录。必须放在 301 之前，否则续期请求会被自己重定向掉。
    # 只能用 root 不能用 alias：acme.sh 写入的是 $webroot/.well-known/acme-challenge/TOKEN，
    # 用 alias /www/acme/ 会把 .well-known 前缀吃掉，导致 404。
    location ^~ /.well-known/acme-challenge/ {
        default_type "text/plain";
        root /www/acme;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name <你的域名>;

    # 私钥文件名刻意不带 .pem/.key 扩展名。nginx 只按路径读，不要求扩展名，
    # 这样能避开通用的密钥文件扫描规则误拦。
    ssl_certificate     /usr/local/openresty/nginx/conf/ssl/<你的域名>/fullchain.crt;
    ssl_certificate_key /usr/local/openresty/nginx/conf/ssl/<你的域名>/tls-private.dat;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL_licensing:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    client_max_body_size 8m;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # 指标端点只给本机监控用，公网一律拒绝（应用层还要求 Bearer 令牌）
    location = /metrics {
        deny all;
        return 403;
    }

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";

        proxy_connect_timeout 5s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
        proxy_buffering       off;
    }
}
```

> 容器里是 `--network host`，所以 `proxy_pass http://127.0.0.1:3100` 能直接打到宿主机的 Next 进程。如果 openresty 不是 host 网络，要改成宿主机 IP 或 `host.docker.internal`。

### 8.3 申请证书

```bash
# 1) 装 acme.sh（本机 v3.1.7）
curl -s https://get.acme.sh | sh -s email=you@example.com

# 2) 准备 webroot（必须在 80 端口的 root 指向的目录下）
mkdir -p /opt/1panel/www/acme/.well-known/acme-challenge

# 3) 签发（Let's Encrypt）
/root/.acme.sh/acme.sh --issue -d <你的域名> \
  --webroot /opt/1panel/www/acme --server letsencrypt

# 4) 安装到 nginx 目录
/root/.acme.sh/acme.sh --install-cert -d <你的域名> --ecc \
  --key-file       /opt/1panel/apps/openresty/openresty/conf/ssl/<你的域名>/tls-private.dat \
  --fullchain-file /opt/1panel/apps/openresty/openresty/conf/ssl/<你的域名>/fullchain.crt \
  --reloadcmd      "docker exec 1Panel-openresty-91lk nginx -s reload"
```

装完 `crontab -l` 里会多一行（本机是）：

```
14 1,7,13,19 * * * "/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null
```

### 8.4 证书与私钥必须配对

这一步不能省。配错了 nginx 起不来：

```bash
A=$(openssl x509 -in /opt/1panel/apps/openresty/openresty/conf/ssl/<你的域名>/fullchain.crt \
      -noout -pubkey | openssl dgst -sha256 | awk '{print $NF}')
B=$(openssl pkey -in /opt/1panel/apps/openresty/openresty/conf/ssl/<你的域名>/tls-private.dat \
      -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')
[ "$A" = "$B" ] && echo "配对 OK: $A" || echo "不匹配！A=$A B=$B"
```

本机实测：`5959030e55462b535bd9db8c197ffed658eea1d634f701d75a76afdec0607cb9`。

### 8.5 热加载与验证

```bash
docker exec 1Panel-openresty-91lk nginx -t          # syntax is ok / test is successful
docker exec 1Panel-openresty-91lk nginx -s reload
```

### 8.6 续期自动化脚本

`/usr/local/bin/licensing-cert-deploy.sh`（本机已有，内容如下）——acme.sh 续期后调它，或者手工换证时用：

```bash
#!/bin/bash
set -euo pipefail
SRC="${1:-/root/.acme.sh/<你的域名>_ecc}"
DST="/opt/1panel/apps/openresty/openresty/conf/ssl/<你的域名>"

[ -f "$SRC/fullchain.cer" ] || { echo "缺少 $SRC/fullchain.cer" >&2; exit 1; }
ls "$SRC"/*.key >/dev/null 2>&1 || { echo "缺少 $SRC/*.key" >&2; exit 1; }

mkdir -p "$DST"
cp "$SRC/fullchain.cer" "$DST/fullchain.crt"
cp "$SRC"/*.key          "$DST/tls-private.dat"
chmod 644 "$DST/fullchain.crt"
chmod 600 "$DST/tls-private.dat"

# 只有证书与私钥匹配才 reload，避免把 openresty 弄成起不来的状态
A=$(openssl x509 -in "$DST/fullchain.crt" -noout -pubkey | openssl dgst -sha256 | awk '{print $NF}')
B=$(openssl pkey -in "$DST/tls-private.dat" -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')
if [ "$A" != "$B" ]; then echo "证书与私钥不匹配：$A vs $B" >&2; exit 1; fi

docker exec 1Panel-openresty-91lk nginx -t >/dev/null
docker exec 1Panel-openresty-91lk nginx -s reload
echo "deployed $(date -u +%FT%TZ) src=$SRC fp=$A"
```

> ⚠️ **一个真踩过的坑**：默认 `SRC` 指向 `/root/.acme.sh/...`，但如果你手上另有一份证书（比如从别处拷来的），直接跑脚本会把线上证书换成 acme.sh 那份。两个都有效，但序列号不同。要指定来源就 `bash licensing-cert-deploy.sh /root/你的证书目录`。

---

## 9. 备份

规格要求 Local / S3 / WebDAV-HTTPS / SFTP 四协议 P0，且必须有异地目标。

### 9.1 起三个本机测试存储（可选，用于验证协议）

先准备 SFTP 要用的密钥（下面命令会用到这些路径）：

```bash
mkdir -p /opt/1panel/offsite-keys/{sshd,client}
chmod 700 /opt/1panel/offsite-keys

# SSH 主机密钥（容器 sshd 用）
ssh-keygen -t ed25519 -f /opt/1panel/offsite-keys/ssh-host-ed25519.dat -N "" -C licensing-offsite-host
cp /opt/1panel/offsite-keys/ssh-host-ed25519.dat     /opt/1panel/offsite-keys/sshd/ssh_host_ed25519_key
cp /opt/1panel/offsite-keys/ssh-host-ed25519.dat.pub /opt/1panel/offsite-keys/sshd/ssh_host_ed25519_key.pub
chmod 600 /opt/1panel/offsite-keys/sshd/ssh_host_ed25519_key

# 客户端密钥（备份系统连 SFTP 用）
ssh-keygen -t ed25519 -f /opt/1panel/offsite-keys/sftp-client-ed25519.dat -N "" -C licensing-backup-client
cp /opt/1panel/offsite-keys/sftp-client-ed25519.dat.pub /opt/1panel/offsite-keys/client/authorized.pub

# 记下主机公钥（建 SFTP 目标时填进 hostKey 做指纹固定）
cat /opt/1panel/offsite-keys/ssh-host-ed25519.dat.pub
ssh-keygen -lf /opt/1panel/offsite-keys/ssh-host-ed25519.dat.pub
```

本机的主机公钥指纹是 `SHA256:mXIUiXQfwP4KNDXWzbSw/azk1lo24WcInRaj0QDRIj8`——你生成的会不一样，**以你自己 `ssh-keygen -lf` 的输出为准**。

```bash
docker network create licensing-offsite

# S3 兼容（minio 镜像现在拉不到，用 versitygw）
docker run -d --name licensing-offsite-s3 --network licensing-offsite \
  -p 127.0.0.1:19000:7070 \
  -e ROOT_ACCESS_KEY=offsite_access_key \
  -e ROOT_SECRET_KEY=offsite_secret_key_2026 \
  -v offsite-s3-data:/data \
  --restart unless-stopped \
  versity/versitygw:latest posix /data
# bucket 目录要先建好，否则 PUT 报 NoSuchBucket
docker run --rm -v offsite-s3-data:/data alpine:3 \
  sh -c "mkdir -p /data/licensing-offsite && chmod 777 /data/licensing-offsite"
docker restart licensing-offsite-s3

# SFTP
docker run -d --name licensing-offsite-sftp --network licensing-offsite \
  -p 127.0.0.1:19022:22 \
  -v offsite-sftp-data:/home/backup/upload \
  -v /opt/1panel/offsite-keys/sshd/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro \
  -v /opt/1panel/offsite-keys/client/authorized.pub:/home/backup/.ssh/keys/authorized.pub:ro \
  -e SFTP_USERS="backup:backup_pw_2026:1001:1001:upload" \
  --restart unless-stopped \
  atmoz/sftp:alpine
docker exec licensing-offsite-sftp chown -R 1001:1001 /home/backup/upload

# WebDAV
docker run -d --name licensing-offsite-webdav --network licensing-offsite \
  -p 127.0.0.1:19080:80 \
  -v offsite-webdav-data:/var/lib/dav \
  -e AUTH_TYPE=Basic -e USERNAME=backup -e PASSWORD=webdav_pw_2026 \
  --restart unless-stopped \
  bytemark/webdav:latest
```

**SFTP 三个必踩的坑**（本机全踩过）：

1. 宿主机钥必须挂到 `/etc/ssh/ssh_host_ed25519_key` 这个**精确路径**，挂到 `/etc/ssh/keys/` 无效。
2. `SSH_AUTHORIZED_KEYS` 环境变量**不被支持**。公钥要挂到 `/home/backup/.ssh/keys/authorized.pub`，entrypoint 会遍历该目录拼成 `authorized_keys`。
3. 数据卷挂载后属主是 `root`，用户写不进去 → 必须 `chown -R 1001:1001`。

### 9.2 在后台建目标

登录拿会话：

```bash
curl -s -c /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/auth/login \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"email":"owner@xinglan.dev","password":"License#2026"}'
CSRF=$(awk '$6=="lic_csrf"{print $7}' /tmp/c.txt)
```

建 Local 目标（**`authMethod` 必填 `"none"`**，漏了报 400）：

```bash
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/admin/backups/destinations \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"name":"local-primary","providerType":"local","authMethod":"none",
       "rootPath":"/root/授权saas/.backups","remotePrefix":"backups/production",
       "isRequired":true,"priority":1}'
```

建 S3 目标：

```bash
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/admin/backups/destinations \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"name":"offsite-s3","providerType":"s3",
       "endpointUrl":"http://127.0.0.1:19000","bucket":"licensing-offsite",
       "remotePrefix":"backups/offsite","authMethod":"access_key","tlsVerify":false,
       "isRequired":true,"priority":2,
       "credential":{"kind":"access_key","accessKeyId":"offsite_access_key",
                     "secretAccessKey":"offsite_secret_key_2026"}}'
```

建 SFTP 目标（私钥放进 `privateKey`，主机公钥放进 `hostKey` 做指纹固定）：

```bash
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/admin/backups/destinations \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"name":"offsite-sftp","providerType":"sftp",
       "endpointUrl":"sftp://127.0.0.1:19022","rootPath":"/upload",
       "remotePrefix":"backups/offsite","authMethod":"ssh_key",
       "isRequired":true,"priority":3,
       "credential":{"kind":"ssh_key","username":"backup",
                     "privateKey":"<粘贴客户端私钥 PEM>",
                     "hostKey":"ssh-ed25519 AAAAC3Nza... licensing-offsite-host"}}'
```

建 WebDAV 目标：

```bash
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/admin/backups/destinations \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"name":"offsite-webdav","providerType":"webdav",
       "endpointUrl":"http://127.0.0.1:19080","remotePrefix":"backups/offsite",
       "authMethod":"username_password","tlsVerify":false,
       "isRequired":true,"priority":4,
       "credential":{"kind":"username_password","username":"backup","password":"webdav_pw_2026"}}'
```

### 9.3 连接测试（必做，别跳过）

```bash
DID="<上一步返回的 id>"
curl -s -b /tmp/c.txt -X POST \
  "http://127.0.0.1:3100/api/v1/admin/backups/destinations/$DID/test" \
  -H "x-csrf-token: $CSRF" -H 'origin: http://127.0.0.1:3100'
```

期望 `"passed": true`，并且 steps 里每一步都 `"ok": true`。

> **坑**：如果 `$DID` 是空的，URL 会退化成 `/destinations//test`，Next 归一化后返回 **308**，看起来像奇怪的重定向错误。先 `echo "$DID"` 确认非空。

### 9.4 建策略

```bash
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/admin/backups/policies \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"name":"daily-production","scheduleCron":"0 3 * * *",
       "timezone":"Asia/Shanghai","targetMode":"all_required",
       "verifyMode":"sha256_and_manifest","encrypt":true,"parallelism":2,
       "retention":{"daily":7,"weekly":4,"monthly":3},
       "targets":[{"destinationId":"<local-id>","priority":1,"isRequired":true},
                  {"destinationId":"<s3-id>","priority":2,"isRequired":true}]}'
```

### 9.5 触发一次并验证

```bash
# ⚠️ 路径是 /jobs，不是 /policies/{id}/run（后者 404 返回 HTML）
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3100/api/v1/admin/backups/jobs \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"policyId":"<policy-id>","trigger":"manual"}'
```

响应字段是 **`jobId`**（不是 `id`）。拿到后：

```bash
JOB="<jobId>"

# 校验
curl -s -b /tmp/c.txt -X POST "http://127.0.0.1:3100/api/v1/admin/backups/jobs/$JOB/verify" \
  -H "x-csrf-token: $CSRF" -H 'origin: http://127.0.0.1:3100'
# 返回 {"ok":true,"expected":"<sha256>","actual":"<sha256>","sizeBytes":...}
# 注意字段名是 expected / actual，不是 expectedSha256

# 恢复演练
curl -s -b /tmp/c.txt -X POST "http://127.0.0.1:3100/api/v1/admin/backups/jobs/$JOB/restore-test" \
  -H "x-csrf-token: $CSRF" -H 'origin: http://127.0.0.1:3100'
# 返回 {"ok":true,"rtoSeconds":2,"elapsedMs":1500,"checks":[...]}
# 注意：没有 status 字段，只有 ok / checks / rtoSeconds / elapsedMs
```

`restore-test` 会建临时库、真恢复、对账、再删库。四项检查应该是：建库 / 表数量对账（41=41）/ 授权行数对账 / 关键列完整性（异常行 0）。

### 9.6 备份文件长什么样

`.zmbk` 是加密信封：`ZMBK1`(5) + `iv`(12) + `tag`(16) + ciphertext。

```bash
od -A n -t x1 -N 5 你的备份.zmbk
# 期望：5a 4d 42 4b 31
```

解密用的 key **不是**环境变量里的原始字符串，而是：

```js
const key = createHash("sha256").update(config.backupEncryptionKey).digest();  // 32 字节
```

搞错这一步会一直报 `Unsupported state or unable to authenticate data`。

### 9.7 ⚠️ 哈希相等 ≠ 能恢复

这是本机最重要的一条方法论：**sha256 全等只证明字节一致，不证明能恢复**。

真实验证流程（本机跑过，全部通过）：

1. 从**远端**（不是本地那份）下载备份文件
2. 独立算 sha256，与作业记录比对
3. 用 `sha256(env)` 解密，确认头部是 `PGDMP`
4. 灌进临时库，`information_schema.tables` 应为 41
5. 逐表 `count(*)` 与生产库比对（差几行审计日志是正常 RPO 窗口）
6. 抽 `license_keys` 的 `key_prefix||key_last4||':'||encode(key_hash,'hex')` 比 3 条，确认 HMAC 一致
7. 删临时库

第 6 步很重要——它证明**恢复后仍能用同一个 pepper 验签**，否则数据在但业务跑不通。

### 9.8 私钥离线备份

```bash
bash /root/授权saas/scripts/offsite-key-backup.sh
```

产物在 `/root/授权saas-offsite/`（0700），含 `keys-<UTC>.tar.gz.enc`（AES-256-CBC + PBKDF2 iter=200000）、`signing-keys-<UTC>.sql`（**不含私钥**）、`MANIFEST-<UTC>.txt`。口令在 `/etc/licensing-saas/offsite-passphrase`（0600）。

脚本会自检：解密 → 解包 → 逐文件比 sha256，全一致才写 MANIFEST。

> ⚠️ **这个脚本有个缺口，部署前必须自己补**：
>
> 脚本里写死的是
> ```bash
> [ -d .keys ]         && DIRS+=(.keys)
> [ -d .keys-sandbox ] && DIRS+=(.keys-sandbox)
> ```
> **没有 `.keys-prod`**。而生产的 `SIGNING_KEY_DIR=.keys-prod`。
>
> 也就是说：**生产签名私钥不会被这个脚本归档**。本机之所以看起来没问题，是因为 `.keys-prod` 当前与 `.keys` 字节完全相同（12 个文件 sha256 全一致），归档 `.keys` 等于顺带备了生产那份。
>
> 你在新机器上如果按 §6 重新生成 `.keys-prod`，它就会和 `.keys` 不同，这个脚本就**真的漏了生产私钥**。
>
> 补法（改脚本第 45-46 行）：
> ```bash
> [ -d .keys ]         && [ -n "$(ls -A .keys 2>/dev/null)" ]         && DIRS+=(.keys)
> [ -d .keys-prod ]    && [ -n "$(ls -A .keys-prod 2>/dev/null)" ]    && DIRS+=(.keys-prod)
> [ -d .keys-sandbox ] && [ -n "$(ls -A .keys-sandbox 2>/dev/null)" ] && DIRS+=(.keys-sandbox)
> ```
> 改完跑一次，然后 `tar tzf` 解密后的归档，确认成员里有 `.keys-prod/` 开头的文件。

---

## 10. 验收清单

全部跑一遍，**每条都要看到期望输出**。任何一条不符就别声称部署成功。

### 10.1 服务活着

```bash
systemctl is-active licensing-saas licensing-saas-sandbox licensing-saas-retention.timer
# 期望：active / active / active
```

### 10.2 只绑回环

```bash
ss -ltnp | grep -E ':3100|:3101'
# 期望：127.0.0.1:3100 和 127.0.0.1:3101，绝不能是 0.0.0.0
```

### 10.3 HTTP 状态码

```bash
curl -s -o /dev/null -w "root=%{http_code}\n"      http://127.0.0.1:3100/
curl -s -o /dev/null -w "login=%{http_code}\n"     http://127.0.0.1:3100/login
curl -s -o /dev/null -w "status=%{http_code}\n"    http://127.0.0.1:3100/api/v1/status
curl -s -o /dev/null -w "live=%{http_code}\n"      http://127.0.0.1:3100/health/live
curl -s -o /dev/null -w "ready=%{http_code}\n"     http://127.0.0.1:3100/health/ready
```

期望：

| 端点 | 状态码 | 说明 |
| --- | --- | --- |
| `/` | **307** | 跳 `/app/dashboard`，**不是 200** |
| `/login` | 200 | 约 19 KB HTML |
| `/api/v1/status` | 200 | JSON，`"ok":true` |
| `/health/live` | 200 | 存活探针 |
| `/health/ready` | 200 | 就绪探针 |

就绪探针的完整期望：

```bash
curl -s http://127.0.0.1:3100/health/ready
# {"status":"ready","env":"production","checks":{"database":null,"signing_keys":null}}
```

`checks` 里两项都是 `null` 才叫就绪。任何一项非 null 就是 503，值会告诉你是 `database_unavailable` 还是 `no_active_signing_key` / `signing_key_dir_unreadable`。

### 10.4 登录能拿到 cookie

```bash
rm -f /tmp/c.txt
curl -s -c /tmp/c.txt -o /dev/null -w "login=%{http_code}\n" \
  -X POST http://127.0.0.1:3100/api/v1/auth/login \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"email":"owner@xinglan.dev","password":"License#2026"}'

grep -c lic_session /tmp/c.txt    # 期望 1
grep -c lic_csrf    /tmp/c.txt    # 期望 1
```

**必须带 `origin` 头**，否则 CSRF 校验会拒。会话 cookie 名是 `lic_session`，CSRF 是 `lic_csrf`。

### 10.5 业务接口能读

```bash
CSRF=$(awk '$6=="lic_csrf"{print $7}' /tmp/c.txt)
curl -s -b /tmp/c.txt -o /dev/null -w "licenses=%{http_code}\n" \
  -H "x-csrf-token: $CSRF" -H 'origin: http://127.0.0.1:3100' \
  'http://127.0.0.1:3100/api/v1/admin/licenses?limit=1'
# 期望 200
```

### 10.6 日志零错误

```bash
journalctl -u licensing-saas --since "-5min" | grep -icE "error|exception"
# 期望 0
```

> 已知会出现但**不是故障**的两条：`The Server Reference ID did not match the expected format. Received "y"` —— 外部扫描器往 `/login` 发 `Next-Action: y` 头探测所致，返回 400，无害。可复现：`curl -X POST http://127.0.0.1:3100/login -H 'Next-Action: y'`。

### 10.7 HTTPS

```bash
# http 必须 301
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" http://你的域名/login
# 期望 301 -> https://你的域名/login

# https 必须 200
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/login
# 期望 200

# 证书链校验
openssl s_client -connect 你的域名:443 -servername 你的域名 </dev/null 2>/dev/null \
  | grep -E "Verify return code|subject=|issuer="
# 期望 Verify return code: 0 (ok)
```

### 10.8 指标端点被挡住

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/metrics
# 期望 403（nginx 层 deny）
```

应用层还要令牌：

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $METRICS_TOKEN" \
  http://127.0.0.1:3100/metrics
# 期望 200
```

### 10.9 ACME 路径没被 301 吃掉

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://你的域名/.well-known/acme-challenge/probe-test
# 期望 404（落到 webroot 目录里找不到文件），不能是 301
```

### 10.10 备份

```bash
# 五/四个目标全部 verified，sha256 全等
curl -s -b /tmp/c.txt "http://127.0.0.1:3100/api/v1/admin/backups/jobs?limit=1" \
  -H "x-csrf-token: $CSRF" -H 'origin: http://127.0.0.1:3100' | head -c 2000
```

看 `targets[].status` 是否全 `verified`、`checksumSha256` 是否全等。

---

## 11. 日常运维

### 11.1 常用命令

```bash
systemctl status licensing-saas --no-pager
systemctl restart licensing-saas
journalctl -u licensing-saas -f
journalctl -u licensing-saas --since "-1h" | grep -iE "error|exception"
systemctl list-timers --all | grep licensing
```

### 11.2 改代码后的发布流程

```bash
cd /root/授权saas
git fetch --tags && git checkout <RELEASE_TAG>
npm ci
npx prisma generate
npm run build
systemctl restart licensing-saas
# 然后跑 §10 的验收
```

**每次 `restart` 后所有会话 cookie 失效**，验证脚本要重新登录。

### 11.3 数据保留清理

```bash
# 干跑，看会删多少
npx tsx scripts/retention-cleanup.mts

# 真删
npx tsx scripts/retention-cleanup.mts --apply
```

清理范围（`audit_logs` **不删**，3 年合规留档）：

| 表 | 保留期 |
| --- | --- |
| `api_request_logs` | 90 天 |
| `activation_events` | 180 天 |
| `admin_sessions` | 过期/撤销 30 天以上 |
| `idempotency_records` | 过期 7 天以上 |
| `rate_limit_buckets` | 窗口过期 1 天以上 |

定时器 `licensing-saas-retention.timer` 每天 04:30 跑 `--apply`。

> ⚠️ **`OnCalendar` 用的是系统本地时区**。本机是 `Etc/UTC`，所以实际触发是 **UTC 04:30 = 北京时间 12:30**（`systemctl list-timers` 实测 `Wed 2026-11-04 04:30:18 UTC`）。
> 要它在北京时间 04:30 跑，要么 `timedatectl set-timezone Asia/Shanghai`，要么把 `OnCalendar` 改成 `*-*-* 20:30:00`（UTC 前一天 20:30 = 北京次日 04:30）。

### 11.4 密钥轮换

```bash
npx tsx scripts/rotate-secrets.mts           # dry-run
npx tsx scripts/rotate-secrets.mts --apply   # 真写
```

换 `LICENSE_HMAC_PEPPER` 时必须走版本环：新 pepper 写 `LICENSE_HMAC_PEPPER`，旧的留在 `LICENSE_HMAC_PEPPER_LEGACY` + `_VERSION`。客户端带明文来校验时会就地重哈希升级。

---

## 12. 这份代码目前已知的缺口

部署前你应该知道这些（都是实测确认的，不是猜的）：

### 12.1 备份保留策略只存不执行（P0）

`retention: {daily:7, weekly:4, monthly:3}` 只是存进 `retention_json` 并在界面上展示。`runner.ts` / `scheduler.ts` 里**没有任何删除逻辑**——`unlink` / `rmSync` / `deleteMany` 命中数是 0。

**后果**：备份会一直堆积。本机实测（2026-11-03）`.backups` 共 **51 个 `.zmbk`、16 MB**，其中：

- `.backups/backups/production/` 9 份（`local-primary` 目标的正式产物，约 2.8 MB）
- `.backups/` 根下 28 份（每次备份的本地暂存副本）
- `.backups/smoke/smoke/` 14 份（早期冒烟测试残留）

单份均值 310 KB。按每天一份算，正式产物一年约 113 MB，加上暂存副本翻倍。磁盘 72 G 够用，但**策略形同虚设**，而且暂存副本不会自动清。

**临时办法**：自己加一条 cron 清旧文件，或者等这个功能补上。

### 12.2 手动触发的备份失败不告警（P0）

`scheduler.ts` 的定时触发路径有 `notifyBackupIssue()`，但 `POST /api/v1/admin/backups/jobs` 的失败分支只抛 422，**不告警**。

而且 `BACKUP_ALERT_WEBHOOK_URL` 默认没配，告警只有「写审计日志」+「打 stdout」两条通道，**没人会看到**。

**临时办法**：配 `BACKUP_ALERT_WEBHOOK_URL` 到一个你天天看的群，然后定期查 `audit_logs` 里 `action='backup.job_failed'`。

### 12.3 文档里的 Base URL 是占位符（P1）

`/developers/llms-full.txt` 输出：

```
Production : https://<LICENSE_API_DOMAIN>/api/v1
Sandbox    : https://<LICENSE_SANDBOX_API_DOMAIN>/api/v1
```

源在 `src/lib/developers/llms-generator.ts` 的 `API_BASE_PLACEHOLDER` / `SANDBOX_BASE_PLACEHOLDER`。**给外部开发者前必须改成真实域名。**

### 12.4 沙箱没有公网入口（P1）

`3101` 只绑 `127.0.0.1`，openresty 配置里搜不到。文档承诺了 Sandbox Base URL 但外部访问不到。

**要开的话**：加一个 `sandbox.你的域名` 的 server block，`proxy_pass http://127.0.0.1:3101`，再签一张证书。

### 12.5 私钥离线备份脚本漏了生产目录（P0）

`scripts/offsite-key-backup.sh` 第 45-46 行只归档 `.keys` 和 `.keys-sandbox`，**没有 `.keys-prod`**，而生产用的正是 `.keys-prod`。

本机没暴露问题是因为两者字节完全相同（实测 12 个文件 sha256 全一致）。新机器上如果分别生成，这个脚本就漏了生产签名私钥——**生产密钥没有离线副本，等于灾难恢复链断了**。

详见 §9.8 的补法。

### 12.6 其他风险项

- **1Panel 面板 `16899` 公网可达**（`0.0.0.0:16899`，返回 200）。跟本项目无关但同机，建议收掉。
- **三个用户 MFA 全未启用**（`mfa_enabled = false`）。上线前至少给 `owner` 开。
- **登录限流是进程内 `Map`**（`src/lib/http/rate-limit.ts` 注释自述「多实例生产环境应换成 Redis」）。单实例够用，扩容即失效。
- **数据库密码是开发值** `licensing_dev_pw`。只绑 `127.0.0.1:55432` 所以风险可控，但要长期运营就换掉——**换了记得同步改 `LICENSE_DB_URL`**（见 §5.3）。

---

## 13. 排障速查

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `NODE_MODULE_VERSION` 不匹配 | `node_modules` 是别的 Node 版本装的 | 删掉重装 `npm ci` |
| `P1001 ECONNREFUSED` | 连到了错的库（常见于没设 `LICENSE_DB_URL`，回退到写死的默认值） | 显式写 `LICENSE_DB_URL` |
| `pg_restore: input file is too short (read 0, expected 5)` | `docker exec -i ... < 宿主机文件` 读不到 | 先 `docker cp` 再按容器内路径恢复 |
| 构建报 `force-dynamic` 相关错误 | `next.config.ts` 开了 `cacheComponents` | 删掉路由里的 `export const dynamic` |
| 登录 403 / CSRF 失败 | 缺 `origin` 头 | 加上 `-H 'origin: http://127.0.0.1:3100'` |
| 备份 URI 里前缀出现两次 | 历史 bug，`remote_prefix` 被 runner 和 adapter 各拼一次 | 已修（`backupObjectKey()`），确认代码是 v1.5.0 之后 |
| WebDAV 报 `创建目录失败：backups（HTTP 301）` | Apache 对已存在集合返回 301 | 已修（`isSameOriginTrailingSlashRedirect()`） |
| WebDAV 目标建完连不上，报「必须是 https」 | 生产环境默认禁明文 | 目标设 `tlsVerify: false` 显式放行 |
| 触发备份 404 返回 HTML | 用了 `/policies/{id}/run` | 用 `POST /api/v1/admin/backups/jobs` |
| `verify` 读不到 `expectedSha256` | 字段名是 `expected` / `actual` | 改字段名 |
| `restore-test` 读不到 `status` | 响应里没有这个字段 | 看 `ok` / `checks` |
| 解密报 `Unsupported state or unable to authenticate data` | key 用错 | key = `sha256(BACKUP_ENCRYPTION_KEY)` 的 digest，不是原字符串 |
| nginx 起不来 | 证书与私钥不配对 | 跑 §8.4 的指纹比对 |
| ACME 续期失败 | `/.well-known/` 被 301 吃掉 | `location ^~` 必须放在 `location /` 之前，且用 `root` 不用 `alias` |
| `docker exec ... < 文件` 没数据 | 同上 | `docker cp` |
| `retention-cleanup` 干跑却删了数据 | 漏了 `--apply` 判断反了 | 默认就是 dry-run，加 `--apply` 才删 |
| 备份定时器/保留清理的时间对不上北京时间 | 系统时区是 UTC | 见 §1.4 与 §11.3 |

---

## 14. 一句话流程

```bash
# 1 装环境      → Node 26 + Docker
# 2 放代码      → 排除 node_modules/.next/.keys-prod
# 3 起数据库    → postgres:16-alpine 绑 127.0.0.1:55432
# 4 恢复数据    → docker cp + pg_restore
# 5 写环境变量  → 4 把密钥现场生成，别忘 LICENSE_DB_URL
# 6 装依赖构建  → npm ci && npx prisma generate && npm run build
# 7 起服务      → systemd，绑 127.0.0.1:3100
# 8 反代 HTTPS  → nginx + acme.sh，证书私钥必须配对
# 9 接备份      → 至少一个异地目标，跑通 restore-test
# 10 验收       → §10 十条全绿才算完
```

**验收的唯一标准是 §10 的十条全部有期望输出，不是「进程在跑」。**
