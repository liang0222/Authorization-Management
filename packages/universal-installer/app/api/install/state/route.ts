/**
 * GET /api/install/state —— 安装向导的启动数据。
 *
 * 返回：状态机当前值、Manifest、环境检测结果、是否允许安装。
 * 同时下发 CSRF token（cookie + 响应体各一份，前端从响应体取更省事）。
 *
 * 这个端点对未登录用户开放（安装期本来就没有账号），但只读、限流、
 * 且已安装时会明确返回 locked，不泄露任何配置值。
 */
import { NextResponse } from "next/server";
import { connection } from "next/server";
import { contractInfo } from "../../../../lib/installer/manifest";
import { describeState, isInstallLocked } from "../../../../lib/installer/state";
import { CSRF_COOKIE, clientIp, checkRateLimit, envelope, failure, issueCsrfToken, INSTALL_RATE_LIMIT } from "../../../../lib/installer/guard";
import { installDataDir, manifest, readEnvironment, readInstallGate } from "../../../../lib/installer/runtime";

export const instant = false;

export async function GET(req: Request) {
  await connection();

  const limit = checkRateLimit(`state:${clientIp(req)}`, { ...INSTALL_RATE_LIMIT, limit: 120 });
  if (!limit.ok) {
    return failure("RATE_LIMITED", "请求过于频繁，请稍后重试", 429);
  }

  const dir = installDataDir();
  const snapshot = await readInstallGate(true);
  const checks = snapshot.state === "INSTALLED" ? [] : await readEnvironment(true);
  const locked = isInstallLocked(snapshot.state);
  const { token, maxAgeSeconds } = issueCsrfToken(dir);

  const response = NextResponse.json(
    envelope({
      state: snapshot.state,
      stateLabel: describeState(snapshot.state),
      source: snapshot.source,
      reason: snapshot.reason,
      tampered: snapshot.tampered,
      adopted: snapshot.adopted,
      installedAt: snapshot.installedAt,
      locked,
      canInstall: !locked,
      manifest: manifest(),
      contract: contractInfo(),
      environment: checks,
      csrfToken: token,
      attempt: snapshot.attempt
        ? {
            id: snapshot.attempt.id,
            status: snapshot.attempt.status,
            startedAt: snapshot.attempt.startedAt,
            finishedAt: snapshot.attempt.finishedAt,
            adminEmail: snapshot.attempt.adminEmail,
            error: snapshot.attempt.error,
            steps: snapshot.attempt.steps,
          }
        : null,
    }),
  );

  response.cookies.set(CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: maxAgeSeconds,
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
