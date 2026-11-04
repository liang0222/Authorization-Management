/**
 * POST /api/install/run —— 执行安装流水线。
 *
 * 保护（规格 §六）：
 *   - 已安装 / 状态未知 → 直接 409，绝不执行（这是「安装完成后服务端强制禁止初始化接口」）；
 *   - CSRF + 同源 + 限流；
 *   - 互斥锁在编排层，第二个人会拿到 409 INSTALL_BUSY 而不是并发出错。
 *
 * 返回的是完整 attempt（每一步的 status / 耗时 / 结论），前端据此渲染进度与失败定位。
 */
import { NextResponse } from "next/server";
import { connection } from "next/server";
import { canRunInstall, describeState } from "@/lib/installer/state";
import { envelope, failure, guardInstallPost } from "@/lib/installer/guard";
import {
  adapter,
  installDataDir,
  invalidateEnvironment,
  invalidateInstallGate,
  manifest,
  readInstallGate,
} from "@/lib/installer/runtime";
import { InstallBusyError, InstallRefusedError, runInstall } from "@/lib/installer/orchestrator";
import type { InstallerConfigInput } from "@/lib/installer/contract";

export const instant = false;
/** 迁移与建表可能很久，给足时间（Next 的默认超时更短）。 */
export const maxDuration = 600;

interface RunBody {
  admin?: Record<string, string>;
  database?: Record<string, string>;
  system?: Record<string, string | boolean | number>;
  resume?: boolean;
}

/** 只保留 Manifest 声明过的字段，防止前端多塞键。 */
function pick(input: Record<string, unknown> | undefined, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const key of keys) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

export async function POST(req: Request) {
  await connection();

  const dir = installDataDir();
  const guard = guardInstallPost(req, dir);
  if (guard) return guard.response;

  const snapshot = await readInstallGate(true);
  if (!canRunInstall(snapshot.state)) {
    return failure(
      "INSTALL_LOCKED",
      `当前状态为「${describeState(snapshot.state)}」，安装入口已关闭。${snapshot.reason}`,
      409,
    );
  }

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    return failure("INVALID_BODY", "请求体不是合法 JSON", 400);
  }

  const m = manifest();
  const input: InstallerConfigInput = {
    admin: pick(body.admin, m.fields.admin.map((f) => f.key)),
    database: pick(body.database, m.fields.database.map((f) => f.key)),
    system: (() => {
      const out: Record<string, string | boolean | number> = {};
      for (const field of m.fields.system) {
        const value = body.system?.[field.key];
        if (value !== undefined && value !== null) out[field.key] = value;
      }
      return out;
    })(),
  };

  try {
    const result = await runInstall({
      adapter: adapter(),
      projectDir: process.cwd(),
      input,
      resume: body.resume === true,
      dataDir: dir,
    });

    invalidateInstallGate();
    invalidateEnvironment();

    return NextResponse.json(
      envelope(
        {
          ok: result.ok,
          attempt: result.attempt,
          snapshot: {
            state: result.snapshot.state,
            source: result.snapshot.source,
            reason: result.snapshot.reason,
            tampered: result.snapshot.tampered,
          },
          config: result.config ?? null,
          redirectTo: result.redirectTo,
        },
        result.ok ? "安装完成" : "安装失败",
      ),
      { status: result.ok ? 200 : 500 },
    );
  } catch (error) {
    if (error instanceof InstallBusyError) {
      return failure("INSTALL_BUSY", error.message, 409);
    }
    if (error instanceof InstallRefusedError) {
      return failure("INSTALL_REFUSED", error.message, 409);
    }
    return failure("INSTALL_ERROR", (error as Error).message, 500);
  }
}
