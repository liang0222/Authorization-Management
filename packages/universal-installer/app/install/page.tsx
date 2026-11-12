import { connection } from "next/server";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Lock, ShieldQuestion } from "lucide-react";
import { InstallWizard } from "../../components/install/wizard";
import { describeState, isInstallLocked } from "../../lib/installer/state";
import { issueCsrfToken } from "../../lib/installer/guard";
import { installDataDir, manifest, readEnvironment, readInstallGate } from "../../lib/installer/runtime";
import { dictionaryFor } from "../../components/install/i18n";

/** cacheComponents 下必须显式声明：本页每次请求都要读安装状态。 */
export const instant = false;

export default async function InstallPage() {
  await connection();

  const snapshot = await readInstallGate(true);
  const m = manifest();
  const dict = dictionaryFor(m.i18n.default);
  const locked = isInstallLocked(snapshot.state);

  /* ---------------- 已安装 / 无法判定：给一个明确的终点，不给安装表单 ---------------- */
  if (locked) {
    const unknown = snapshot.state === "UNKNOWN";
    const Icon = unknown ? ShieldQuestion : Lock;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-muted/40">
          <Icon className="size-7 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            {unknown ? dict.unknown : dict.locked}
          </h1>
          <p className="text-sm text-muted-foreground">
            {unknown ? dict.unknownHint : dict.lockedHint}
          </p>
        </div>

        <dl className="w-full space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">状态</dt>
            <dd className="font-medium">{describeState(snapshot.state)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">判定依据</dt>
            <dd className="text-right">{snapshot.source}</dd>
          </div>
          {snapshot.installedAt ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">安装时间</dt>
              <dd className="font-mono text-xs">{snapshot.installedAt}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">说明</dt>
            <dd className="max-w-[70%] text-right text-xs text-muted-foreground">{snapshot.reason}</dd>
          </div>
        </dl>

        {snapshot.tampered ? (
          <div className="flex w-full items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              检测到安装锁异常（缺失或被改动）。安装入口已锁定；如需排查请查看安装器数据目录与数据库
              <code className="mx-1 rounded bg-background/60 px-1">installer_records</code>
              表。
            </span>
          </div>
        ) : null}

        <div className="flex gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {dict.goLogin}
          </Link>
          <Link
            href="/install"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            {dict.refresh}
          </Link>
        </div>
      </main>
    );
  }

  /* ---------------- 未安装：进向导 ---------------- */
  const checks = await readEnvironment(true);
  const { token } = issueCsrfToken(installDataDir());

  return (
    <InstallWizard
      manifest={m}
      initialState={snapshot.state}
      stateReason={snapshot.reason}
      environment={checks}
      csrfToken={token}
      resumeAttempt={
        snapshot.attempt && snapshot.attempt.status === "failed"
          ? {
              id: snapshot.attempt.id,
              adminEmail: snapshot.attempt.adminEmail ?? null,
              failedPhase: snapshot.attempt.error?.phase ?? null,
              failedMessage: snapshot.attempt.error?.message ?? null,
            }
          : null
      }
    />
  );
}
