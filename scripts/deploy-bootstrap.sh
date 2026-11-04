#!/usr/bin/env bash
# 一键部署：把「解压出来的代码目录」变成「systemd 管着、健康检查通过的实例」。
#
# 用法（在项目根目录执行，需要 root）：
#   ./scripts/deploy-bootstrap.sh                     # 从头跑到尾
#   ./scripts/deploy-bootstrap.sh --with-docker-pg    # 顺带起 PostgreSQL 容器
#   ./scripts/deploy-bootstrap.sh --restore-dump=/tmp/x.dump
#       # 恢复前会 DROP SCHEMA public CASCADE（让结果与全新库一致）；
#       # 想保留库里现有对象加 --keep-schema
#
# 脚本全程不提问，所有选择都用参数给定。可以分段跑，段与段幂等：
#   ./scripts/deploy-bootstrap.sh --skip-db        # 库和数据已就绪，只做装依赖/构建/服务
#
# 安全守卫：目标 systemd 单元已存在、且指向另一个目录时**拒绝覆盖**并退出非 0。
# 要接管同名单元请显式 --force；部署第二实例请用 --service-name 换名。
#   ./scripts/deploy-bootstrap.sh --only=build     # 只到构建为止，不碰 systemd
#   ./scripts/deploy-bootstrap.sh --only=systemd   # 只装/更新 systemd 单元并验证
#   ./scripts/deploy-bootstrap.sh --port=3101 --bind=127.0.0.1 \
#       --service-name=licensing-saas-sandbox --env-file=/etc/licensing-saas/sandbox.env
#
# 它做的事，按顺序：
#   1. 前置检查：node / npm 版本、目录、root 权限、端口占用
#   2. 生成环境文件 /etc/licensing-saas/production.env（4 把密钥现场随机生成，
#      已存在则保留不覆盖 —— 覆盖会让所有会话与密文失效）
#   3. 可选：起 PostgreSQL 容器（--with-docker-pg）
#   4. 可选：恢复 dump（--restore-dump=/path/to.dump）
#   5. npm ci + prisma generate
#   6. prisma migrate deploy  ← 漏了这步，恢复旧 dump 后会 500「列不存在」
#   7. 体检并补齐签名私钥 ← 漏了这步，服务自称 ready 但签发全 503
#   8. npm run build
#   9. 写 systemd 单元并启用
#  10. 真验证：/health/ready 200 + 登录接口 200 + 日志无 error
#
# 退出码：0 全部通过；非 0 表示某一步没通过，日志就在 stdout 里，不要跳步继续。
set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; NC=$'\033[0m'
say()  { echo "${BLUE}==>${NC} $*"; }
ok()   { echo "${GREEN}  ✓${NC} $*"; }
warn() { echo "${YELLOW}  !${NC} $*"; }
die()  { echo "${RED}  ✗${NC} $*" >&2; exit 1; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR=/etc/licensing-saas
ENV_FILE="$ENV_DIR/production.env"
SERVICE_NAME=licensing-saas
PORT="${APP_PORT:-3100}"
BIND="${APP_BIND:-127.0.0.1}"

ONLY=all
FORCE=0
SKIP_DB=0
WITH_DOCKER_PG=0
RESTORE_DUMP=""
KEEP_SCHEMA=0
NODE_MAJOR_MIN=22

for arg in "$@"; do
  case "$arg" in
    --only=*)            ONLY="${arg#*=}" ;;
    --skip-db)           SKIP_DB=1 ;;
    --with-docker-pg)    WITH_DOCKER_PG=1 ;;
    --restore-dump=*)    RESTORE_DUMP="${arg#*=}" ;;
    --keep-schema)       KEEP_SCHEMA=1 ;;
    --port=*)            PORT="${arg#*=}" ;;
    --bind=*)            BIND="${arg#*=}" ;;
    --env-file=*)        ENV_FILE="${arg#*=}"; ENV_DIR="$(dirname "$ENV_FILE")" ;;
    --service-name=*)    SERVICE_NAME="${arg#*=}" ;;
    --pg-container=*)    PG_CONTAINER_OVERRIDE="${arg#*=}" ;;
    --force)             FORCE=1 ;;
    --non-interactive)   : ;;   # 脚本本来就不提问，保留这个参数只为兼容习惯
    -h|--help)           sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$arg（--help 看用法）" ;;
  esac
done

case "$ONLY" in
  all|build|systemd) ;;
  *) die "--only 只接受 all / build / systemd，收到 $ONLY" ;;
esac

say "项目目录：$PROJECT_DIR"
say "执行范围：$ONLY   端口：$BIND:$PORT"

# ───────────────────────────────────────────────────── 1. 前置检查
say "1/10 前置检查"
[ "$(id -u)" = "0" ] || die "需要 root（要写 /etc/systemd 与 $ENV_DIR）"
[ -f "$PROJECT_DIR/package.json" ] || die "$PROJECT_DIR 下没有 package.json，脚本要放在项目的 scripts/ 里"
command -v node >/dev/null || die "没装 node"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ] || die "Node $NODE_MAJOR 太旧，至少要 $NODE_MAJOR_MIN（Next 16 要求）"
ok "node $(node -v) / npm $(npm -v)"

if command -v ss >/dev/null && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
  warn "端口 $PORT 已被占用 —— 如果就是本服务在跑，先 systemctl stop $SERVICE_NAME"
fi

# ───────────────────────────────────────────────────── 2. 环境文件
say "2/10 环境文件 $ENV_FILE"
gen() { node -e "console.log(require('node:crypto').randomBytes(${1:-32}).toString('base64url'))"; }
mkdir -p "$ENV_DIR"; chmod 750 "$ENV_DIR"

if [ -f "$ENV_FILE" ]; then
  warn "已存在，保留不覆盖（覆盖会让所有会话与密文失效）"
  ok "复用现有 $ENV_FILE"
else
  DB_URL_DEFAULT="postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public"
  cat > "$ENV_FILE" <<ENVEOF
DEPLOYMENT_ENV=production
LICENSE_DB_URL=${DB_URL_DEFAULT}
SIGNING_KEY_DIR=.keys-prod
BACKUP_LOCAL_DIR=.backups-prod
APP_BASE_URL=http://${BIND}:${PORT}
ASSERTION_AUDIENCE=license-api
DEV_MAIL_SINK=false

SESSION_SECRET=$(gen 32)
SECRETBOX_KEY=$(gen 32)
BACKUP_ENCRYPTION_KEY=$(gen 32)
LICENSE_HMAC_PEPPER=$(gen 32)
LICENSE_HMAC_PEPPER_VERSION=v2
LICENSE_HMAC_PEPPER_LEGACY=dev-only-license-hmac-pepper-please-change-in-production
LICENSE_HMAC_PEPPER_LEGACY_VERSION=v1
METRICS_TOKEN=$(node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))")

# 对外展示的 API 基址。不配就显示「未配置」，不会编假域名。
PUBLIC_API_BASE_URL=
PUBLIC_SANDBOX_API_BASE_URL=
ENVEOF
  chmod 600 "$ENV_FILE"
  ok "已生成（4 把密钥现场随机；LICENSE_DB_URL 默认指向本机 55432 容器）"
  warn "上线前务必改 LICENSE_DB_URL 的密码，并填 PUBLIC_API_BASE_URL"
fi

# 从环境文件里取 DB URL 与密钥目录，后续步骤都靠它
set -a; . "$ENV_FILE"; set +a

# 环境文件已存在但没有 LICENSE_DB_URL —— 这是最容易静默出错的状态：
# config.ts 会回退到写死的开发默认地址，连不上才报 P1001，连上了就是「连错库」。
# 这里不猜、不默默继续，直接补一行并明确告知。
if [ -z "${LICENSE_DB_URL:-}" ]; then
  DB_URL_FALLBACK="postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public"
  warn "环境文件里没有 LICENSE_DB_URL（config.ts 会回退到开发默认地址，换机器就会连错库）"
  printf '\n# 由 deploy-bootstrap.sh 补充：缺这一行会静默回退到开发默认地址\nLICENSE_DB_URL=%s\n' \
    "$DB_URL_FALLBACK" >> "$ENV_FILE"
  LICENSE_DB_URL="$DB_URL_FALLBACK"
  ok "已补上 LICENSE_DB_URL=$DB_URL_FALLBACK（换成你自己的密码后再重启）"
fi
SIGNING_KEY_DIR="${SIGNING_KEY_DIR:-.keys-prod}"
[ -n "$SIGNING_KEY_DIR" ] || die "SIGNING_KEY_DIR 为空"
mkdir -p "$PROJECT_DIR/$SIGNING_KEY_DIR"
chmod 700 "$PROJECT_DIR/$SIGNING_KEY_DIR"
ok "密钥目录 $SIGNING_KEY_DIR 已就绪（0700）"

# ───────────────────────────────────────────────────── 3. 数据库容器（可选）
# 从 LICENSE_DB_URL 拆出 PG 连接信息，供容器与 psql/pg_restore 使用。
# 不能硬编码：部署第二实例（沙箱）时硬编码会把数据灌进生产库。
PG_USER="$(node -e "console.log(decodeURIComponent(new URL(process.env.LICENSE_DB_URL).username))" 2>/dev/null || true)"
PG_PASS="$(node -e "console.log(decodeURIComponent(new URL(process.env.LICENSE_DB_URL).password))" 2>/dev/null || true)"
PG_DB="$(node -e "const u=new URL(process.env.LICENSE_DB_URL);console.log(u.pathname.replace(/^\\//,''))" 2>/dev/null || true)"
PG_HOST="$(node -e "console.log(new URL(process.env.LICENSE_DB_URL).hostname)" 2>/dev/null || true)"
PG_PORT="$(node -e "const u=new URL(process.env.LICENSE_DB_URL);console.log(u.port||'5432')" 2>/dev/null || true)"
[ -n "$PG_USER" ] && [ -n "$PG_DB" ] || die "无法从 LICENSE_DB_URL 解析出用户名/库名：$LICENSE_DB_URL"
PG_CONTAINER="${PG_CONTAINER_OVERRIDE:-${PG_CONTAINER:-licensing-pg}}"
say "目标库：${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}（容器 ${PG_CONTAINER}）"

# 容器操作（起容器 / pg_restore）之前先确认「这个容器确实是 LICENSE_DB_URL 指的那台」。
# 端口对不上就停下来说清楚 —— 否则最坏的可能是把 dump 灌进生产库。
ensure_container_matches_url() {
  docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || \
    die "容器 $PG_CONTAINER 不存在。要新建请加 --with-docker-pg；用别的容器请加 --pg-container=名字"
  local mapped
  mapped="$(docker inspect "$PG_CONTAINER" \
    --format '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{.HostPort}} {{end}}{{end}}' 2>/dev/null | tr -s ' ')"
  if [ -n "$mapped" ] && ! echo "$mapped" | grep -qw "$PG_PORT"; then
    die "容器 $PG_CONTAINER 映射的宿主端口是 [$mapped]，但 LICENSE_DB_URL 指向 127.0.0.1:${PG_PORT}。
      这两者不是同一个库。确认清楚再继续，别把数据灌进错的库。"
  fi
  ok "容器 $PG_CONTAINER 与 LICENSE_DB_URL 匹配（宿主端口 $PG_PORT）"
}

if [ "$WITH_DOCKER_PG" = "1" ]; then
  say "3/10 起 PostgreSQL 容器"
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker start "$PG_CONTAINER" >/dev/null
    ok "$PG_CONTAINER 已存在，已启动（用的是库里已有的数据卷，不会清空）"
  else
    docker run -d --name "$PG_CONTAINER" --restart unless-stopped \
      -p "127.0.0.1:${PG_PORT}:5432" \
      -e POSTGRES_USER="$PG_USER" -e "POSTGRES_PASSWORD=$PG_PASS" -e "POSTGRES_DB=$PG_DB" \
      -v "${PG_CONTAINER}-data:/var/lib/postgresql/data" postgres:16-alpine >/dev/null
    ok "已创建 $PG_CONTAINER（只绑 127.0.0.1:${PG_PORT}）"
  fi
  for _ in $(seq 1 30); do
    docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null || die "PG 30 秒内没就绪"
else
  say "3/10 跳过数据库容器（要起请加 --with-docker-pg）"
fi

# ───────────────────────────────────────────────────── 4. 恢复 dump（可选）
if [ -n "$RESTORE_DUMP" ]; then
  say "4/10 恢复 dump：$RESTORE_DUMP"
  [ -f "$RESTORE_DUMP" ] || die "找不到 $RESTORE_DUMP"
  head -c 5 "$RESTORE_DUMP" | grep -q PGDMP || die "不是 custom format dump（前 5 字节应为 PGDMP）"
  ensure_container_matches_url

  # 恢复之前先把 public schema 清干净。
  #
  # 为什么光靠 pg_restore --clean 不够：--clean 只 DROP **dump 里出现过的**对象。
  # 如果这个库以前迁移过，会留下 dump 里没有的类型（典型是 enum）。
  # 实测过的具体故障：库里已有 enum credential_environment、但
  # product_credentials 表被 --clean 重建后没了 environment 列；
  # 接着跑 prisma migrate deploy 重建该类型时炸
  #   ERROR: type "credential_environment" already exists (SqlState E42710)
  # 迁移被记成失败，之后怎么重跑都过不去。
  #
  # DROP SCHEMA public CASCADE 顺手把这类残留一起清掉，让恢复结果与
  # 「全新库灌 dump」完全一致 —— 这正是恢复备份应有的语义。
  # 已经有数据会被销毁，所以只在指定 --restore-dump 时才做，且日志明说。
  if [ "$KEEP_SCHEMA" = "1" ]; then
    warn "--keep-schema：跳过 schema 重置（库里可能有与 dump 冲突的残留类型）"
  else
    say "重置 public schema（恢复的语义就是「让库变成 dump 那一刻的样子」）"
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q \
      -c 'DROP SCHEMA IF EXISTS public CASCADE' \
      -c 'CREATE SCHEMA public' \
      -c "GRANT ALL ON SCHEMA public TO \"$PG_USER\"" \
      -c 'GRANT ALL ON SCHEMA public TO public' || die "重置 public schema 失败"
    ok "schema 已重置"
  fi

  # 必须 docker cp：docker exec -i ... pg_restore < 宿主文件 会让容器读到 0 字节
  docker cp "$RESTORE_DUMP" "$PG_CONTAINER:/tmp/restore.dump"
  docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" \
    --no-owner /tmp/restore.dump || warn "pg_restore 有告警（对象已存在/权限类告警通常可忽略）"
  docker exec "$PG_CONTAINER" rm -f /tmp/restore.dump
  ok "dump 已恢复"
else
  say "4/10 跳过 dump 恢复（要恢复请加 --restore-dump=/path/to.dump）"
fi

# ───────────────────────────────────────────────────── 5. 依赖 + Prisma Client
say "5/10 安装依赖并生成 Prisma Client"
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
npx prisma generate
ok "依赖与 Prisma Client 就绪"

# ───────────────────────────────────────────────────── 6. 迁移
if [ "$SKIP_DB" = "1" ]; then
  say "6/10 跳过迁移（--skip-db）"
else
  say "6/10 应用数据库迁移"
  # ⚠️ 这一步不能省。旧 dump 里的 _prisma_migrations 可能比代码里的迁移少，
  # 少的那几个迁移带来的新列会让所有查询报 42703「列不存在」。
  #
  # 另一条：确认用的是本地锁定的 prisma。仓库里没有 node_modules 时
  # `npx prisma` 会去公网拉最新版（实测拉到 8.0.0-rc.30，把 migrate deploy
  # 改名成 db migrate 了）。第 5 步已经 npm ci，这里再验一次更稳。
  PRISMA_VER="$(npx prisma --version 2>/dev/null | sed -n 's/^prisma *: *//p' | head -1)"
  case "$PRISMA_VER" in
    7.*) ok "prisma $PRISMA_VER（与项目锁定一致）" ;;
    "")  warn "读不到 prisma 版本，继续（第 5 步 npm ci 应已装好）" ;;
    *)   die "prisma 版本是 $PRISMA_VER，项目锁的是 7.x。
      多半是 node_modules 里没有 prisma，npx 从公网拉了一份。
      先跑 npm ci 再重试。" ;;
  esac
  npx prisma migrate deploy
  ok "迁移已全部应用"
fi

# ───────────────────────────────────────────────────── 7. 签名私钥体检
if [ "$SKIP_DB" = "1" ]; then
  say "7/10 跳过私钥体检（--skip-db）"
else
  say "7/10 体检签名私钥"
  # 私钥刻意不随包、不随 dump 走。从备份恢复的数据里 signing_keys 有记录、
  # 但 .keys-prod 是空的 —— 那种状态服务会自称 ready，签发时全 503。
  SECRETS_ENV_FILE="$ENV_FILE" npx tsx scripts/repair-signing-keys.mts | tee /tmp/repair-keys.log
  if grep -q "缺失" /tmp/repair-keys.log; then
    warn "发现缺失的私钥，正在补齐（会生成新密钥并写回公钥）"
    SECRETS_ENV_FILE="$ENV_FILE" npx tsx scripts/repair-signing-keys.mts --apply
    ok "私钥已补齐"
  else
    ok "所有私钥文件都在"
  fi
fi

# ───────────────────────────────────────────────────── 8. 构建
say "8/10 构建"
npm run build
ok "构建完成"

# ───────────────────────────────────────────────────── 9. systemd
if [ "$ONLY" = "build" ]; then
  say "9/10 跳过 systemd（--only=build）"
else
  say "9/10 安装 systemd 单元"
  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

  # 防呆：目标单元已存在且指向**另一个目录**时拒绝覆盖。
  #
  # 这条守卫是被真实事故逼出来的：我在 /tmp 里演练脚本，忘了它默认服务名是
  # licensing-saas，结果把生产单元覆盖成了 WorkingDirectory=/tmp/... -p 3197，
  # 生产服务当场指向一个临时目录。systemd 不会拦你，`systemctl restart` 也不会报错，
  # 只会安静地跑起另一个目录里的代码。
  #
  # 要覆盖请显式 --force，或者用 --service-name 换个名字（部署第二实例就该这么做）。
  if [ -f "$UNIT_PATH" ] && [ "$FORCE" = "0" ]; then
    EXISTING_WD="$(sed -n 's|^WorkingDirectory=||p' "$UNIT_PATH" | head -1)"
    if [ -n "$EXISTING_WD" ] && [ "$EXISTING_WD" != "$PROJECT_DIR" ]; then
      echo
      die "拒绝覆盖 $UNIT_PATH：它现在指向 $EXISTING_WD，不是 $PROJECT_DIR。
      这多半意味着同名服务已经在跑了（生产实例？）。
      部署第二实例请加 --service-name=另一个名字；
      确实要接管这个单元，加 --force。"
    fi
  fi

  cat > "$UNIT_PATH" <<UNITEOF
[Unit]
Description=Licensing SaaS (Next.js) on ${BIND}:${PORT}
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/npm run start -- -p ${PORT} -H ${BIND}
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNITEOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"
  ok "已启用并重启 $SERVICE_NAME"
fi

# ───────────────────────────────────────────────────── 10. 真验证
if [ "$ONLY" = "build" ] || [ "$SKIP_DB" = "1" ]; then
  say "10/10 跳过运行时验证"
else
  say "10/10 真验证（等 20 秒让服务起来）"
  for _ in $(seq 1 20); do
    curl -fsS "http://${BIND}:${PORT}/health/live" >/dev/null 2>&1 && break
    sleep 1
  done

  code() { curl -s -o /dev/null -w "%{http_code}" "$1"; }
  LIVE=$(code "http://${BIND}:${PORT}/health/live")
  READY=$(code "http://${BIND}:${PORT}/health/ready")
  LOGIN=$(code "http://${BIND}:${PORT}/login")
  ROOT=$(code "http://${BIND}:${PORT}/")

  echo "    /health/live   $LIVE  （期望 200）"
  echo "    /health/ready  $READY （期望 200；503 看下面这句里的 checks 字段）"
  echo "    /login         $LOGIN （期望 200）"
  echo "    /              $ROOT  （期望 307，跳到 /app/dashboard）"

  if [ "$READY" != "200" ]; then
    echo "    ready 详情：$(curl -s "http://${BIND}:${PORT}/health/ready")"
    warn "not_ready 常见两种：signing_key_unreadable（私钥文件缺，跑第 7 步）、"
    warn "database 有错（连接串错或库没起）"
  fi

  ERRS=$(journalctl -u "$SERVICE_NAME" --since "-3min" --no-pager 2>/dev/null | grep -icE "error|exception" || true)
  # grep -c 在没有匹配时返回退出码 1，配合 `set -e` 会直接退脚本，
  # 所以上面必须 `|| true`；这也是最容易写错的一行。
  echo "    journalctl error/exception 计数：${ERRS}（期望 0）"

  if [ "$LIVE" = "200" ] && [ "$READY" = "200" ] && [ "$LOGIN" = "200" ] && [ "$ROOT" = "307" ] && [ "$ERRS" = "0" ]; then
    echo
    echo "${GREEN}全部通过。${NC} 下一步："
    echo "  1) 配反向代理与证书：docs/DEPLOY-v15.md §8"
    echo "  2) 去后台改掉种子密码：owner@xinglan.dev / License#2026"
    echo "  3) 配异地备份：docs/DEPLOY-v15.md §9"
  else
    echo
    warn "有项目没达标，先别上线。排查顺序：docs/DEPLOY-v15.md §13"
    exit 1
  fi
fi
