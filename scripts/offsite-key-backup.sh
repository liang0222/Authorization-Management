#!/usr/bin/env bash
# 签名私钥离线恢复材料（规格 24 Go-Live Gate：远端校验通过、解密私钥在服务器外安全保存）。
#
# 产出（默认落在 /root/授权saas-offsite，0700）：
#   1. keys-<UTC>.tar.gz.enc   —— .keys 与 .keys-sandbox 的加密归档（AES-256-CBC + PBKDF2）
#   2. signing-keys-<UTC>.sql  —— 只含元数据（kid / 指纹 / 状态 / 有效期），**不含私钥**
#   3. MANIFEST-<UTC>.txt      —— 归档与明文的 sha256、成员清单、恢复步骤
#
# 口令单独放在 /etc/licensing-saas/offsite-passphrase（0600）：
#   它不在归档里，也不在 MANIFEST 里 —— 拿不到它，归档就是一堆随机字节。
#   正确做法是把它抄到密码管理器或离线介质，然后从本机删掉。
#
# 用法：
#   ./scripts/offsite-key-backup.sh                 # 打包并自检
#   OUT_DIR=/mnt/usb ./scripts/offsite-key-backup.sh
#
# 自检会真的解密、解包、逐个比对 sha256，全部一致才写 MANIFEST。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-/root/授权saas-offsite}"
PASS_FILE="${PASS_FILE:-/etc/licensing-saas/offsite-passphrase}"
ARCHIVE="${OUT_DIR}/keys-${STAMP}.tar.gz.enc"
META_SQL="${OUT_DIR}/signing-keys-${STAMP}.sql"
MANIFEST="${OUT_DIR}/MANIFEST-${STAMP}.txt"
DB_CONTAINER="${DB_CONTAINER:-licensing-pg}"
DB_NAME="${DB_NAME:-licensing}"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

if [ ! -s "$PASS_FILE" ]; then
  mkdir -p "$(dirname "$PASS_FILE")"
  openssl rand -hex 32 > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
  echo "==> 已生成新的归档口令：$PASS_FILE（务必抄走后从本机删除）"
else
  echo "==> 复用已有归档口令：$PASS_FILE"
fi

# 只打包真正存在且非空的密钥目录；沙箱没跑过就不进归档。
DIRS=()
[ -d .keys ] && [ -n "$(ls -A .keys 2>/dev/null)" ] && DIRS+=(.keys)
[ -d .keys-sandbox ] && [ -n "$(ls -A .keys-sandbox 2>/dev/null)" ] && DIRS+=(.keys-sandbox)
if [ ${#DIRS[@]} -eq 0 ]; then
  echo "没有可归档的密钥目录（.keys / .keys-sandbox）" >&2
  exit 1
fi

echo "==> 归档目录：${DIRS[*]}"
# 打包前先算原文明细，恢复后逐条比对。
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -czf "$WORK/keys.tar.gz" "${DIRS[@]}"
( cd "$WORK" && tar -xzf keys.tar.gz -C "$WORK/src" 2>/dev/null || ( mkdir -p "$WORK/src" && tar -xzf keys.tar.gz -C "$WORK/src" ) )

openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$WORK/keys.tar.gz" -out "$ARCHIVE" -pass "file:${PASS_FILE}"
chmod 600 "$ARCHIVE"

# 自检：解密 → 解包 → 逐文件比 sha256。只输出数量与结论，不打印任何密钥内容。
mkdir -p "$WORK/restored"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$ARCHIVE" -out "$WORK/restored.tar.gz" -pass "file:${PASS_FILE}"
mkdir -p "$WORK/restored.src"
tar -xzf "$WORK/restored.tar.gz" -C "$WORK/restored.src"

expected="$(cd "$WORK/src" && find . -type f -exec sha256sum {} + | sed 's|  \./|  |' | sort -k2)"
actual="$(cd "$WORK/restored.src" && find . -type f -exec sha256sum {} + | sed 's|  \./|  |' | sort -k2)"
count="$(printf '%s\n' "$expected" | wc -l)"
if [ "$expected" != "$actual" ]; then
  echo "自检失败：解密后的文件与源文件不一致" >&2
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
  exit 1
fi

# 元数据（不含私钥）：给 Runbook 与灾备演练对照用。
docker exec "$DB_CONTAINER" psql -U "${DB_USER:-licensing}" -d "$DB_NAME" -Atc \
  "select kid || E'\t' || status || E'\t' || coalesce(private_key_ref,'-') || E'\t' || \
   coalesce(encode(public_key,'hex'),'-') || E'\t' || coalesce(not_after::text,'-') \
   from signing_keys order by created_at" > "$WORK/keys.tsv"
{
  echo "-- 签名密钥元数据快照 ${STAMP}（只含公钥与引用，不含任何私钥内容）"
  echo "-- 恢复时用：把 .keys 解回去，再用 private_key_ref 与 kid 对齐 signing_keys 表"
  echo "-- kid	status	private_key_ref	public_key_hex	not_after"
  cat "$WORK/keys.tsv"
} > "$META_SQL"
chmod 600 "$META_SQL"

ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
{
  echo "签名私钥离线恢复材料"
  echo "生成时间（UTC）：${STAMP}"
  echo "源目录：${ROOT}（${DIRS[*]}）"
  echo
  echo "[归档] $ARCHIVE"
  echo "  sha256 : $ARCHIVE_SHA"
  echo "  大小   : $(stat -c %s "$ARCHIVE") 字节"
  echo "  算法   : AES-256-CBC + PBKDF2(iter=200000)，口令见 $PASS_FILE"
  echo "  自检   : 解密→解包→逐文件 sha256 全部一致（${count} 个文件）"
  echo
  echo "[明文清单] 相对路径 与 sha256（仅文件名与摘要，不含密钥内容）"
  printf '%s\n' "$expected" | sed 's/^/  /'
  echo
  echo "[元数据] $META_SQL（kid / 状态 / 私钥文件名 / 公钥 hex / 有效期）"
  echo
  echo "[恢复步骤]"
  echo "  1. openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in <归档> -out keys.tar.gz -pass file:<口令文件>"
  echo "  2. tar -xzf keys.tar.gz -C /root/授权saas"
  echo "  3. chmod 700 .keys && chmod 600 .keys/* 2>/dev/null; chmod 600 .keys/credentials/* 2>/dev/null"
  echo "  4. 对照 signing-keys-*.sql 校验每个 private_key_ref 都存在"
  echo "  5. systemctl restart licensing-saas && curl /api/v1/status"
  echo
  echo "[注意] 口令文件不在归档内。归档与口令分开放置，缺一不可恢复。"
} > "$MANIFEST"
chmod 600 "$MANIFEST"

echo
echo "==> 完成"
echo "  归档   : $ARCHIVE ($(stat -c %s "$ARCHIVE") 字节, sha256 ${ARCHIVE_SHA:0:16}…)"
echo "  元数据 : $META_SQL"
echo "  清单   : $MANIFEST"
echo "  自检   : ${count} 个文件解密后 sha256 全部一致"
echo "  口令   : $PASS_FILE —— 抄到密码管理器/离线介质后从本机删除"
