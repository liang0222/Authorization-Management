/**
 * 数据保留清理（规格 17.5）。
 *
 * 只删「已经过保留期、且不属于合规留档」的数据：
 * - api_request_logs：90 天（聚合统计不依赖明细）
 * - activation_events：180 天
 * - admin_sessions：过期或已撤销 30 天以上
 * - idempotency_records：已过期 7 天以上
 * - rate_limit_buckets：窗口已过期 1 天以上
 *
 * audit_logs 不在这里删（3 年，且需要可审计的删除动作本身）。
 *
 * 用法：npx tsx scripts/retention-cleanup.mts [--apply] [--dry-run]
 * 默认 dry-run；`--apply` 才真正执行 DELETE。
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/lib/config.js";

const APPLY = process.argv.includes("--apply");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

interface Step {
  name: string;
  cutoffs: { label: string; value: Date }[];
  count: (cutoff: Date) => Promise<number>;
  remove: (cutoff: Date) => Promise<number>;
}

const steps: Step[] = [
  {
    name: "api_request_logs",
    cutoffs: [{ label: "90d", value: daysAgo(90) }],
    count: (c) => prisma.api_request_logs.count({ where: { created_at: { lt: c } } }),
    remove: (c) => prisma.api_request_logs.deleteMany({ where: { created_at: { lt: c } } }).then((r) => r.count),
  },
  {
    name: "activation_events",
    cutoffs: [{ label: "180d", value: daysAgo(180) }],
    count: (c) => prisma.activation_events.count({ where: { created_at: { lt: c } } }),
    remove: (c) => prisma.activation_events.deleteMany({ where: { created_at: { lt: c } } }).then((r) => r.count),
  },
  {
    name: "admin_sessions",
    cutoffs: [{ label: "revoked/expired 30d", value: daysAgo(30) }],
    count: (c) =>
      prisma.admin_sessions.count({
        where: { OR: [{ revoked_at: { lt: c } }, { expires_at: { lt: c } }] },
      }),
    remove: (c) =>
      prisma.admin_sessions
        .deleteMany({ where: { OR: [{ revoked_at: { lt: c } }, { expires_at: { lt: c } }] } })
        .then((r) => r.count),
  },
  {
    name: "idempotency_records",
    cutoffs: [{ label: "expired 7d", value: daysAgo(7) }],
    count: (c) => prisma.idempotency_records.count({ where: { expires_at: { lt: c } } }),
    remove: (c) => prisma.idempotency_records.deleteMany({ where: { expires_at: { lt: c } } }).then((r) => r.count),
  },
  {
    name: "rate_limit_buckets",
    cutoffs: [{ label: "window 1d", value: daysAgo(1) }],
    count: (c) => prisma.rate_limit_buckets.count({ where: { window_start: { lt: c } } }),
    remove: (c) => prisma.rate_limit_buckets.deleteMany({ where: { window_start: { lt: c } } }).then((r) => r.count),
  },
];

async function main() {
  console.log(`[retention] mode=${APPLY ? "apply" : "dry-run"} db=${config.databaseUrl.replace(/:[^:@/]+@/, ":***@")}`);
  let total = 0;
  for (const step of steps) {
    for (const cutoff of step.cutoffs) {
      const n = APPLY ? await step.remove(cutoff.value) : await step.count(cutoff.value);
      total += n;
      console.log(`[retention] ${step.name.padEnd(20)} ${cutoff.label.padEnd(18)} ${APPLY ? "deleted" : "would delete"}=${n}`);
    }
  }
  console.log(`[retention] ${APPLY ? "已删除" : "将删除"}合计 ${total} 行`);
  if (!APPLY) console.log("[retention] 这是 dry-run；确认无误后加 --apply 执行。");
}

main()
  .catch((error) => {
    console.error("[retention] 失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
