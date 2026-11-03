#!/usr/bin/env bash
# 建/重置 Sandbox 环境（规格 27.3「独立数据库 + 独立凭证 + 独立签名密钥」）。
#
# 做四件事，全部幂等：
#   1. 在同一个 PostgreSQL 实例里建独立库 licensing_sandbox（不存在才建）；
#   2. 对它跑 prisma migrate deploy；
#   3. 用 SEED_CREDENTIAL_ENVIRONMENT=sandbox 灌种子，得到一套沙箱专属 client_id；
#   4. 把沙箱签名私钥写到 SIGNING_KEY_DIR（默认 .keys-sandbox），与生产 .keys 完全分离。
#
# 用法：
#   ./scripts/sandbox-bootstrap.sh            # 首次建库
#   RESET=1 ./scripts/sandbox-bootstrap.sh    # 清空重建（沙箱数据会全丢，这是设计）
#
# 需要环境变量（缺省值与 docker 里的 licensing-pg 一致）：
#   PGHOST/PGPORT 或 LICENSE_DB_URL 的宿主部分、PGUSER、PGPASSWORD
set -euo pipefail

CONTAINER="${SANDBOX_PG_CONTAINER:-licensing-pg}"
DB_NAME="${SANDBOX_DB_NAME:-licensing_sandbox}"
DB_USER="${SANDBOX_DB_USER:-licensing}"
HOST_URL="${SANDBOX_DB_HOST_URL:-postgresql://licensing:licensing_dev_pw@127.0.0.1:55432}"
export SIGNING_KEY_DIR="${SIGNING_KEY_DIR:-.keys-sandbox}"
export BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-.backups-sandbox}"
export SEED_CREDENTIAL_ENVIRONMENT=sandbox
export LICENSE_DB_URL="${HOST_URL}/${DB_NAME}?schema=public"

echo "==> 目标库 ${DB_NAME}（容器 ${CONTAINER}）"

exists="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -Atc \
  "select 1 from pg_database where datname='${DB_NAME}'")"

if [ "${RESET:-0}" = "1" ] && [ -n "$exists" ]; then
  echo "==> RESET=1：删除并重建 ${DB_NAME}"
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE ${DB_NAME}" >/dev/null
  exists=""
fi

if [ -z "$exists" ]; then
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}" >/dev/null
  echo "==> 已创建 ${DB_NAME}"
else
  echo "==> ${DB_NAME} 已存在，跳过创建（要重来请加 RESET=1）"
fi

echo "==> 应用迁移"
npx prisma migrate deploy

echo "==> 灌入沙箱种子（client_id 为沙箱专属）"
npx tsx prisma/seed.ts

echo
echo "==> 完成。沙箱凭证："
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "select client_id || '  ' || credential_type || '  ' || environment from product_credentials order by client_id"
echo
echo "启动实例（另开一个 systemd unit，端口 3101）见 docs/v15-runbook.md"
