/**
 * GET /api/install/log —— 最近一次安装尝试的日志（已脱敏）。
 *
 * 只读、限流、不需要登录（安装期没有账号），但绝不返回任何配置值：
 * 日志在写入时就已经过 redact()。
 */
import { NextResponse } from "next/server";
import { connection } from "next/server";
import { checkRateLimit, clientIp, envelope, failure, INSTALL_RATE_LIMIT } from "@/lib/installer/guard";
import { installDataDir } from "@/lib/installer/runtime";
import { latestAttempt, readLog } from "@/lib/installer/store";

export const instant = false;

export async function GET(req: Request) {
  await connection();

  const limit = checkRateLimit(`log:${clientIp(req)}`, { ...INSTALL_RATE_LIMIT, limit: 60 });
  if (!limit.ok) {
    return failure("RATE_LIMITED", "请求过于频繁，请稍后重试", 429);
  }

  const dir = installDataDir();
  const url = new URL(req.url);
  const maxLines = Math.min(Number(url.searchParams.get("lines") ?? 200) || 200, 1000);

  const lines = readLog(dir, maxLines).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { raw: line };
    }
  });

  const attempt = latestAttempt(dir);

  return NextResponse.json(
    envelope({
      lines,
      attempt: attempt
        ? {
            id: attempt.id,
            status: attempt.status,
            startedAt: attempt.startedAt,
            finishedAt: attempt.finishedAt,
            error: attempt.error,
            steps: attempt.steps,
          }
        : null,
    }),
  );
}
