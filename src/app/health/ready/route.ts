import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

/**
 * GET /health/ready —— 就绪探针（规格 18.2）。
 *
 * 与 /health/live 的区别：这里真的去查一次数据库、确认签名密钥目录可读。
 * 任何一项失败返回 503，让负载均衡把流量摘走；返回体只给“哪个组件不健康”，
 * 不带连接串、主机名、密钥路径等内部信息。
 */
async function checkDatabase(): Promise<string | null> {
  try {
    await prisma.$queryRaw`select 1`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 120) : "database_unavailable";
  }
}

async function checkSigningKeys(): Promise<string | null> {
  try {
    const active = await prisma.signing_keys.count({ where: { status: "active" } });
    if (active === 0) return "no_active_signing_key";
    // 目录存在性比“读到私钥”更轻，且不会把私钥内容带进进程日志。
    const { access, constants } = await import("node:fs/promises");
    await access(config.signingKeyDir, constants.R_OK);
    return null;
  } catch {
    return "signing_key_dir_unreadable";
  }
}

export async function GET() {
  const checks: Record<string, string | null> = {
    database: await checkDatabase(),
    signing_keys: await checkSigningKeys(),
  };
  const failures = Object.entries(checks)
    .filter(([, problem]) => problem !== null)
    .map(([name, problem]) => ({ name, problem }));

  return NextResponse.json(
    {
      status: failures.length === 0 ? "ready" : "not_ready",
      env: config.deploymentEnv,
      checks,
    },
    { status: failures.length === 0 ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
