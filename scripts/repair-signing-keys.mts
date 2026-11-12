/**
 * 从 dump / 备份恢复之后，补齐「数据库里有记录、磁盘上没有文件」的私钥。
 *
 * 为什么需要这个脚本：
 *   `signing_keys` 表只存 kid 与私钥文件名（`private_key_ref`），私钥本体是
 *   `SIGNING_KEY_DIR/<kid>.pem`（0600）。这条路刻意的：私钥绝不进 dump，
 *   也绝不进发布包。所以把一个 dump 恢复到新机器后，状态是
 *   「表里有 active 密钥行、目录里一个文件都没有」——
 *   `/health/ready` 会通过（它以前只数 active 行），
 *   直到某次真正签发授权/离线许可时才 503「签名私钥文件不可读」。
 *   同理 `product_credentials` 里 confidential_server 的私钥在
 *   `SIGNING_KEY_DIR/credentials/<client_id>.pem`，缺了就跑不通 private_key_jwt。
 *
 * 本脚本做两件事：
 *   1. `signing_keys`：为每一行缺失私钥的记录**重新生成一对 Ed25519 密钥**，
 *      私钥落盘（0600），并把库里那行的 `public_key` 一起更新成新公钥。
 *      —— 公钥必须同步更新，否则 DB 里的公钥和磁盘私钥不是一对，
 *      签出来的令牌用库里的公钥验不过。这就是「密钥轮换」，语义上必须成对。
 *   2. `product_credentials`（confidential_server）：同样补生成私钥文件。
 *      注意这会让**已经配置好公钥的外部调用方失效**，他们需要拿新公钥重配；
 *      所以默认只报告，加 `--apply` 才真的写。
 *
 * 用法：
 *   npx tsx scripts/repair-signing-keys.mts            # 只体检，列出缺什么
 *   npx tsx scripts/repair-signing-keys.mts --apply    # 真补（会改库里的 public_key）
 *   npx tsx scripts/repair-signing-keys.mts --apply --only=signing   # 只补签名密钥
 *   npx tsx scripts/repair-signing-keys.mts --apply --only=credentials
 *
 * 环境变量文件默认读 `/etc/licensing-saas/production.env`，可用 SECRETS_ENV_FILE 覆盖。
 * 需要 `LICENSE_DB_URL` 与 `SIGNING_KEY_DIR`。
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : "all";
if (!["all", "signing", "credentials"].includes(only)) {
  console.error(`--only 只接受 all / signing / credentials，收到 ${only}`);
  process.exit(2);
}

const envFile = process.env.SECRETS_ENV_FILE ?? "/etc/licensing-saas/production.env";
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
  }
} else {
  console.warn(`[repair] 环境文件不存在：${envFile}（继续用当前进程环境）`);
}

const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client.js");
const { config } = await import("../src/lib/config.js");

const keyDir = resolve(process.cwd(), config.signingKeyDir);
console.log(`[repair] SIGNING_KEY_DIR = ${keyDir}`);
console.log(`[repair] 模式 = ${apply ? "APPLY（会写库与落盘）" : "DRY-RUN（只报告）"}  范围 = ${only}`);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.LICENSE_DB_URL }),
});

/** Ed25519 SPKI DER 固定头，与 signing-key.ts / 管理路由保持一致。 */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_LENGTH = 32;

function formatKid(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `sk_${yyyy}${mm}${dd}_${randomBytes(8).toString("hex")}`;
}

function fingerprint(der: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(der)).digest().subarray(0, 16).toString("hex");
}

/** 写私钥：目录 0700、文件 0600、已存在则拒绝覆盖（不能悄悄换掉一把在用的密钥）。 */
function writePrivateKey(path: string, pem: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return true;
}

// ─────────────────────────────────────────────────────── 1. 授权签名密钥
let signingMissing = 0;
if (only === "all" || only === "signing") {
  const rows = await prisma.signing_keys.findMany({
    where: { status: { in: ["active", "staged", "retiring"] } },
    select: {
      id: true,
      kid: true,
      private_key_ref: true,
      status: true,
      public_key: true,
      organization_id: true,
      product_id: true,
      not_before: true,
      not_after: true,
    },
    orderBy: { created_at: "desc" },
  });
  console.log(`\n[repair] signing_keys：${rows.length} 行（active/staged/retiring）`);
  for (const row of rows) {
    const file = resolve(keyDir, basename(row.private_key_ref));
    if (existsSync(file)) {
      const print = fingerprint(row.public_key);
      console.log(`   OK   ${row.kid}  [${row.status}]  公钥指纹 ${print}`);
      continue;
    }
    signingMissing += 1;
    console.log(`   缺失 ${row.kid}  [${row.status}]  期望文件 ${basename(row.private_key_ref)}`);

    if (!apply) continue;
    if (row.status === "retiring") {
      // retiring 只用于「验旧签名」，不签新东西。私钥缺了不影响签发，
      // 但会让「验证旧令牌」这条路断掉。这里显式跳过并让人工决定。
      console.log(`        ↳ retiring 状态跳过（只验旧签名，私钥缺失不影响新签发）`);
      continue;
    }

    // 关键：公钥必须跟着换。留着旧 public_key 而换私钥，签出来的东西验不过。
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    if (der.length !== SPKI_PREFIX.length + RAW_KEY_LENGTH || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
      throw new Error(`导出的公钥不是标准 Ed25519 SPKI（长度 ${der.length}），已中止`);
    }
    const newKid = formatKid(new Date());
    const newRef = `${newKid}.pem`;
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    writePrivateKey(resolve(keyDir, newRef), pem);

    /**
     * 新行**继承原行的状态与时间窗**，不能一律写成 active。
     *
     * 踩过的坑：一条 `staged` 密钥表示「已生成、还没到 not_before、不许用来签东西」。
     * 补私钥时把它建成 active，等于把一把本该 7 天后才生效的密钥提前启用，
     * 库里会同时出现多个 active 行，`loadActiveSigningKey` 取最新那条，
     * 于是「轮换预案」被悄悄执行了。
     */
    const nextStatus = row.status;
    await prisma.signing_keys.update({
      where: { id: row.id },
      data: { status: row.status === "active" ? "retiring" : "revoked" },
    });
    await prisma.signing_keys.create({
      data: {
        organization_id: row.organization_id,
        product_id: row.product_id,
        kid: newKid,
        algorithm: "EdDSA",
        public_key: Uint8Array.from(der),
        private_key_ref: newRef,
        status: nextStatus,
        not_before: row.not_before,
        not_after: row.not_after,
      },
    });
    console.log(
      `        ↳ 已生成 ${newKid}（公钥指纹 ${fingerprint(der)}，状态 ${nextStatus}），旧行降为 ${row.status === "active" ? "retiring" : "revoked"}`,
    );
  }
}

// ─────────────────────────────────────────────────────── 2. 服务端凭证私钥
let credMissing = 0;
if (only === "all" || only === "credentials") {
  const creds = await prisma.product_credentials.findMany({
    where: { credential_type: "confidential_server" },
    select: { id: true, client_id: true, environment: true, public_key: true },
    orderBy: { client_id: "asc" },
  });
  console.log(`\n[repair] product_credentials(confidential_server)：${creds.length} 行`);
  for (const cred of creds) {
    const file = resolve(keyDir, "credentials", `${cred.client_id}.pem`);
    if (existsSync(file)) {
      console.log(`   OK   ${cred.client_id}  [${cred.environment}]`);
      continue;
    }
    credMissing += 1;
    console.log(`   缺失 ${cred.client_id}  [${cred.environment}]`);
    if (!apply) continue;

    // 警告：换私钥必须换公钥，调用方手里的旧公钥立刻失效。
    // 生产上正确做法是让调用方重新提交公钥（管理后台「新建凭证」可粘贴公钥），
    // 这里只是让本机恢复到「能跑起来」的状态。
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    writePrivateKey(file, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await prisma.product_credentials.update({
      where: { id: cred.id },
      data: { public_key: Uint8Array.from(der) },
    });
    console.log(`        ↳ 新公钥已写回库，指纹 ${fingerprint(der)}（外部调用方需重配公钥）`);
  }
}

// ─────────────────────────────────────────────────────── 3. 一致性守卫
// 多个 active 行不会让服务崩，但会让「当前用哪把签」变成看 created_at 的排序运气。
// 启动闸门不查这个（它只管密钥是不是默认值），所以在这里显式提醒。
if (only === "all" || only === "signing") {
  const activeRows = await prisma.signing_keys.count({ where: { status: "active" } });
  if (activeRows > 1) {
    console.log(
      `\n[repair] ⚠️ 库里有 ${activeRows} 行 active 签名密钥；` +
        `loadActiveSigningKey 取 created_at 最新那条。正常只应有 1 行，请人工确认其余是否该转 retiring。`,
    );
  }
}

console.log(`\n[repair] 小结：签名密钥缺 ${signingMissing} 个、凭证私钥缺 ${credMissing} 个`);
if (!apply && signingMissing + credMissing > 0) {
  console.log(`[repair] 这是 DRY-RUN。确认无误后加 --apply 真正修复。`);
}
if (signingMissing + credMissing > 0 && apply) {
  console.log(`[repair] 已修复。请重启服务并复查 /health/ready 与一次真实签发。`);
}
await prisma.$disconnect();
