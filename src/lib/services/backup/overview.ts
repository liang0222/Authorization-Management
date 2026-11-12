import { prisma } from "@/lib/db";
import { evaluateInsecureHttpTarget } from "./insecure-http";
import { config } from "@/lib/config";

/**
 * 「备份与灾备」概览（规格 16.10 要求的那一块）。
 *
 * 这里的原则是**只说得出证据的话**：
 * - RPO 目标取自主备策略的调度节奏（每天一次 → 24 小时），实测 RPO 取最近一次成功备份距今的时长；
 * - RTO 目标是我们给的运维承诺（30 分钟），实测 RTO 只认隔离恢复演练真实跑出来的秒数；
 * - WAL 归档状态如实报「未启用」——当前是逻辑备份（pg_dump 自定义格式），
 *   没有 WAL 归档就没有 PITR，这一点不能靠文案糊过去（物理备份 + WAL 归档属于 P1）。
 */

export const RTO_TARGET_SECONDS = 30 * 60;

export interface BackupOverview {
  targets: { rpoSeconds: number; rtoSeconds: number };
  measured: { rpoSeconds: number | null; rtoSeconds: number | null };
  lastSuccess: { id: string; backupId: string; finishedAt: string | null; sizeBytes: number | null } | null;
  lastFailure: { id: string; backupId: string; finishedAt: string | null; errorCode: string | null; errorMessage: string | null } | null;
  lastVerifiedAt: string | null;
  lastRestoreTest: {
    id: string;
    status: string;
    finishedAt: string | null;
    rtoSeconds: number | null;
  } | null;
  destinations: {
    total: number;
    enabled: number;
    healthy: number;
    failing: number;
    untested: number;
    /** http + 非回环的目标数（凭据会明文过网的那一类）。 */
    plaintext: number;
    /** 其中被双重确认放行的数量。 */
    plaintextAccepted: number;
    /** 其中当前条件不满足、执行期会被跳过的数量。 */
    plaintextBlocked: number;
  };
  jobs30d: { total: number; succeeded: number; failed: number; partial: number; degraded: number; successRate: number };
  totalSizeBytes: number;
  retention: unknown;
  wal: { enabled: boolean; note: string };
  generatedAt: string;
}

export async function buildBackupOverview(organizationId: string): Promise<BackupOverview> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const [destinations, jobs30d, lastSuccess, lastFailure, lastVerified, lastRestore, policy, sizeSum] = await Promise.all([
    prisma.backup_storage_destinations.findMany({
      where: { organization_id: organizationId },
      select: { enabled: true, last_test_status: true, endpoint_url: true, tls_verify: true },
    }),
    prisma.backup_jobs.findMany({
      where: { organization_id: organizationId, created_at: { gte: since } },
      select: { status: true },
    }),
    prisma.backup_jobs.findFirst({
      where: { organization_id: organizationId, status: { in: ["succeeded", "degraded", "partial"] } },
      orderBy: { finished_at: "desc" },
      select: { id: true, backup_id: true, finished_at: true, size_bytes: true },
    }),
    prisma.backup_jobs.findFirst({
      where: { organization_id: organizationId, status: "failed" },
      orderBy: { finished_at: "desc" },
      select: { id: true, backup_id: true, finished_at: true, error_code: true, error_message: true },
    }),
    prisma.backup_job_targets.findFirst({
      where: { organization_id: organizationId, status: "verified", verified_at: { not: null } },
      orderBy: { verified_at: "desc" },
      select: { verified_at: true },
    }),
    prisma.backup_restore_tests.findFirst({
      where: { organization_id: organizationId, status: { in: ["passed", "failed"] } },
      orderBy: { created_at: "desc" },
      select: { id: true, status: true, finished_at: true, rto_seconds: true },
    }),
    prisma.backup_policies.findFirst({
      where: { organization_id: organizationId, enabled: true },
      orderBy: { created_at: "asc" },
      select: { retention_json: true, schedule_cron: true },
    }),
    prisma.backup_jobs.aggregate({
      where: { organization_id: organizationId, created_at: { gte: since }, size_bytes: { not: null } },
      _sum: { size_bytes: true },
    }),
  ]);

  // 明文 http 目标的现状（阶段 4）：概览页要能一眼看到「有几个目标会明文过网」。
  const plaintextGuards = destinations.map((item) =>
    evaluateInsecureHttpTarget({
      deploymentEnv: config.deploymentEnv,
      endpointUrl: item.endpoint_url,
      tlsVerify: item.tls_verify,
    }),
  );

  const succeeded = jobs30d.filter((job) => job.status === "succeeded").length;
  const total = jobs30d.length;

  const rpoMeasured = lastSuccess?.finished_at
    ? Math.max(0, Math.round((Date.now() - new Date(lastSuccess.finished_at).getTime()) / 1000))
    : null;

  return {
    targets: { rpoSeconds: 24 * 3600, rtoSeconds: RTO_TARGET_SECONDS },
    measured: {
      rpoSeconds: rpoMeasured,
      rtoSeconds: lastRestore?.status === "passed" ? lastRestore.rto_seconds ?? null : null,
    },
    lastSuccess: lastSuccess
      ? {
          id: lastSuccess.id,
          backupId: lastSuccess.backup_id,
          finishedAt: lastSuccess.finished_at ? new Date(lastSuccess.finished_at).toISOString() : null,
          sizeBytes: lastSuccess.size_bytes === null ? null : Number(lastSuccess.size_bytes),
        }
      : null,
    lastFailure: lastFailure
      ? {
          id: lastFailure.id,
          backupId: lastFailure.backup_id,
          finishedAt: lastFailure.finished_at ? new Date(lastFailure.finished_at).toISOString() : null,
          errorCode: lastFailure.error_code,
          errorMessage: lastFailure.error_message,
        }
      : null,
    lastVerifiedAt: lastVerified?.verified_at ? new Date(lastVerified.verified_at).toISOString() : null,
    lastRestoreTest: lastRestore
      ? {
          id: lastRestore.id,
          status: lastRestore.status,
          finishedAt: lastRestore.finished_at ? new Date(lastRestore.finished_at).toISOString() : null,
          rtoSeconds: lastRestore.rto_seconds,
        }
      : null,
    destinations: {
      total: destinations.length,
      enabled: destinations.filter((item) => item.enabled).length,
      healthy: destinations.filter((item) => item.last_test_status === "passed").length,
      failing: destinations.filter((item) => item.last_test_status === "failed").length,
      untested: destinations.filter((item) => item.last_test_status === "untested").length,
      plaintext: plaintextGuards.filter((item) => item.plaintext).length,
      plaintextAccepted: plaintextGuards.filter((item) => item.plaintext && item.targetConfirmed && item.envConfirmed).length,
      plaintextBlocked: plaintextGuards.filter((item) => !item.allowed).length,
    },
    jobs30d: {
      total,
      succeeded,
      failed: jobs30d.filter((job) => job.status === "failed").length,
      partial: jobs30d.filter((job) => job.status === "partial").length,
      degraded: jobs30d.filter((job) => job.status === "degraded").length,
      successRate: total === 0 ? 0 : Math.round((succeeded / total) * 1000) / 1000,
    },
    totalSizeBytes: Number(sizeSum._sum.size_bytes ?? 0),
    retention: policy?.retention_json ?? null,
    wal: {
      enabled: false,
      note: "当前为逻辑备份（pg_dump 自定义格式），未开启 WAL 归档；连续归档 + 物理备份属于 P1，届时才有 PITR 能力。",
    },
    generatedAt: new Date().toISOString(),
  };
}
