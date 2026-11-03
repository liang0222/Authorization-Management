/**
 * 密钥轮换收尾脚本：把用旧密钥封存的机密用当前密钥重新封存。
 *
 * 背景：`secretbox` 已支持「当前密钥 + 只读旧密钥」的密钥环，旧密文在读取时
 * 能自动解开，但那只是兼容期。真正换完密钥后要让 `SECRETBOX_KEYS_LEGACY` 变成
 * 空字符串，否则旧密钥永远是新密钥泄露时的第二把钥匙。
 *
 * 用法：
 *   npx tsx scripts/rotate-secrets.mts            # 只报告，不写库
 *   npx tsx scripts/rotate-secrets.mts --apply    # 真正重封存
 *
 * 幂等：已经是当前密钥封存的行会被跳过（先试解当前密钥，成功即跳过）。
 */
import { readFileSync } from "node:fs";

const apply = process.argv.includes("--apply");

// 先注入环境变量，config 在模块加载期求值。
const envFile = process.env.SECRETS_ENV_FILE ?? "/etc/licensing-saas/production.env";
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
}

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client.ts");
const { openWithKeys, sealSecret } = await import("../src/lib/auth/secretbox.ts");
const { config } = await import("../src/lib/config.ts");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });

/** 尝试用当前密钥解开；成功说明这一行已经轮换过。 */
function isCurrent(sealed: string): boolean {
  try {
    openWithKeys([config.secretboxKey], sealed);
    return true;
  } catch {
    return false;
  }
}

let scanned = 0;
let rotated = 0;
let skipped = 0;
let failed = 0;

async function processTable(
  table: string,
  rows: { id: string; sealed: string }[],
  write: (id: string, sealed: string) => Promise<unknown>,
) {
  for (const row of rows) {
    scanned += 1;
    if (isCurrent(row.sealed)) {
      skipped += 1;
      continue;
    }
    let plaintext: string;
    try {
      plaintext = openWithKeys(config.secretboxLegacyKeys, row.sealed);
    } catch {
      failed += 1;
      console.error(`[rotate] ${table}/${row.id} 旧密钥也解不开，需要人工处理`);
      continue;
    }
    if (!apply) {
      console.log(`[rotate] ${table}/${row.id} 将重新封存（dry-run）`);
      rotated += 1;
      continue;
    }
    await write(row.id, sealSecret(plaintext));
    rotated += 1;
    console.log(`[rotate] ${table}/${row.id} 已重新封存`);
  }
}

const hooks = await prisma.webhook_endpoints.findMany({
  where: { secret_enc: { not: null } },
  select: { id: true, secret_enc: true },
});
await processTable("webhook_endpoints", hooks.map((h) => ({ id: h.id, sealed: h.secret_enc! })), (id, sealed) =>
  prisma.webhook_endpoints.update({ where: { id }, data: { secret_enc: sealed } }),
);

const backupCreds = await prisma.backup_storage_credentials.findMany({
  where: { revoked_at: null },
  select: { id: true, ciphertext: true },
});
await processTable(
  "backup_storage_credentials",
  backupCreds.map((c) => ({ id: c.id, sealed: Buffer.from(c.ciphertext).toString("utf8") })),
  (id, sealed) =>
    prisma.backup_storage_credentials.update({
      where: { id },
      data: { ciphertext: Buffer.from(sealed, "utf8") },
    }),
);

const mfaUsers = await prisma.users.findMany({
  where: { mfa_secret_enc: { not: null } },
  select: { id: true, mfa_secret_enc: true },
});
await processTable("users", mfaUsers.map((u) => ({ id: u.id, sealed: u.mfa_secret_enc! })), (id, sealed) =>
  prisma.users.update({ where: { id }, data: { mfa_secret_enc: sealed } }),
);

await prisma.$disconnect();

console.log(
  `[rotate] mode=${apply ? "apply" : "dry-run"} env=${config.deploymentEnv} 扫描=${scanned} 重封存=${rotated} 已是最新=${skipped} 失败=${failed}`,
);
if (failed > 0) process.exitCode = 1;
if (skipped === scanned && scanned > 0) {
  console.log("[rotate] 全部已用当前密钥封存，可以清空 SECRETBOX_KEYS_LEGACY。");
}
