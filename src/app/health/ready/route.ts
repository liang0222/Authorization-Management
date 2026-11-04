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
    // 只数 active 行是不够的：把 dump 恢复到一个新机器时，signing_keys 里有 kid 和
    // 私钥文件名，但 SIGNING_KEY_DIR 是空的（私钥刻意不随包、不随 dump 走）。
    // 那种状态下服务会一直自称 ready，直到真正签发授权时才 503
    // 「签名私钥文件不可读」—— 探针等于没探。
    // 所以这里一路查到「当前会被用来签名的那个私钥文件确实可读」。
    const [active] = await prisma.signing_keys.findMany({
      where: { status: "active" },
      select: { private_key_ref: true },
      orderBy: { created_at: "desc" },
      take: 1,
    });
    if (!active) return "no_active_signing_key";

    const { access, constants } = await import("node:fs/promises");
    const { basename, join, resolve } = await import("node:path");
    await access(config.signingKeyDir, constants.R_OK);

    // private_key_ref 只存文件名，和 signing-key.ts 一样用 basename 兜住目录穿越。
    const keyPath = resolve(join(resolve(process.cwd(), config.signingKeyDir), basename(active.private_key_ref)));
    await access(keyPath, constants.R_OK);
    return null;
  } catch {
    // 不回传路径（探针是免登录端点），只说明「密钥目录或当前私钥文件不可用」。
    return "signing_key_unreadable";
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
