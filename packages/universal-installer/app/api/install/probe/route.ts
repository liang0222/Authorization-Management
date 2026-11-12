/**
 * POST /api/install/probe —— 分步检测（数据库连接 / 初始化条件）。
 *
 * 向导里「测试连接」按钮调它。独立成一个端点是为了让用户在提交整张表单之前
 * 就能拿到明确的失败原因（密码错、库不存在、没权限各不一样）。
 */
import { NextResponse } from "next/server";
import { connection } from "next/server";
import { canRunInstall } from "../../../../lib/installer/state";
import { envelope, failure, guardInstallPost } from "../../../../lib/installer/guard";
import { adapter, installDataDir, readInstallGate } from "../../../../lib/installer/runtime";
import type { InstallerConfigInput } from "../../../../lib/installer/contract";

export const instant = false;

interface ProbeBody {
  database?: Record<string, string>;
}

export async function POST(req: Request) {
  await connection();

  const dir = installDataDir();
  const guard = guardInstallPost(req, dir);
  if (guard) return guard.response;

  const snapshot = await readInstallGate(true);
  if (!canRunInstall(snapshot.state)) {
    return failure("INSTALL_LOCKED", `当前状态为「${snapshot.state}」，安装入口已关闭`, 409);
  }

  let body: ProbeBody;
  try {
    body = (await req.json()) as ProbeBody;
  } catch {
    return failure("INVALID_BODY", "请求体不是合法 JSON", 400);
  }

  const input: InstallerConfigInput = {
    admin: {},
    database: body.database ?? {},
    system: {},
  };

  const target = adapter();
  const [test, inspection] = await Promise.all([
    target.testDatabase(input),
    target.inspectDatabase(input),
  ]);

  return NextResponse.json(
    envelope({
      database: test,
      inspection,
    }),
  );
}
