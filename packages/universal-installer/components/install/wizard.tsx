"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import type {
  CheckItem,
  FieldDescriptor,
  InstallState,
  ProjectManifest,
  StepRecord,
} from "../../lib/installer/contract";
import { dictionaryFor } from "./i18n";

type WizardStep = "admin" | "database" | "system" | "review" | "run" | "done";

const STEP_ORDER: WizardStep[] = ["admin", "database", "system", "review", "run"];

interface ResumeAttempt {
  id: string;
  adminEmail: string | null;
  failedPhase: string | null;
  failedMessage: string | null;
}

interface Props {
  manifest: ProjectManifest;
  initialState: InstallState;
  stateReason: string;
  environment: CheckItem[];
  csrfToken: string;
  resumeAttempt: ResumeAttempt | null;
}

interface RunResult {
  ok: boolean;
  attempt: {
    id: string;
    status: string;
    steps: StepRecord[];
    error?: { phase: string; message: string };
  };
  config: { path: string; keys: string[]; backupPath?: string } | null;
  redirectTo: string;
}

const STATUS_ICON = {
  ok: <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />,
  failed: <X className="size-4 text-destructive" aria-hidden />,
  running: <Loader2 className="size-4 animate-spin text-primary" aria-hidden />,
  skipped: <Circle className="size-4 text-muted-foreground" aria-hidden />,
  pending: <Circle className="size-4 text-muted-foreground/40" aria-hidden />,
} as const;

const CHECK_TONE = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  fail: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

export function InstallWizard(props: Props) {
  const { manifest } = props;
  const dict = dictionaryFor(manifest.i18n.default);

  const [step, setStep] = useState<WizardStep>("admin");
  const [admin, setAdmin] = useState<Record<string, string>>(() => defaults(manifest.fields.admin));
  const [database, setDatabase] = useState<Record<string, string>>(() => defaults(manifest.fields.database));
  const [system, setSystem] = useState<Record<string, string>>(() => defaults(manifest.fields.system));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [envChecks, setEnvChecks] = useState<CheckItem[]>(props.environment);
  const [envLoading, setEnvLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    target: string;
    message: string;
    hint?: string;
    warnings?: string[];
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logLines, setLogLines] = useState<Array<Record<string, unknown>>>([]);

  const currentIndex = STEP_ORDER.indexOf(step);

  /* --------------------------------------------------------------- 表单渲染 */

  const setField = (group: "admin" | "database" | "system") => (key: string, value: string) => {
    const setter = group === "admin" ? setAdmin : group === "database" ? setDatabase : setSystem;
    setter((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /* --------------------------------------------------------------- 校验 */

  const validateStep = (target: WizardStep): boolean => {
    const next: Record<string, string> = {};
    const check = (fields: FieldDescriptor[], values: Record<string, string>) => {
      for (const field of fields) {
        const value = values[field.key] ?? "";
        if (field.required && value.trim() === "") {
          next[field.key] = dict.requiredField;
          continue;
        }
        if (value && field.minLength !== undefined && value.length < field.minLength) {
          next[field.key] = `至少 ${field.minLength} 个字符`;
        }
        if (value && field.maxLength !== undefined && value.length > field.maxLength) {
          next[field.key] = `最多 ${field.maxLength} 个字符`;
        }
        if (value && field.pattern) {
          try {
            if (!new RegExp(field.pattern).test(value)) next[field.key] = "格式不符合要求";
          } catch {
            /* Manifest 里的正则由服务端兜底校验 */
          }
        }
        if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          next[field.key] = "邮箱格式不正确";
        }
      }
    };

    if (target === "database" || target === "review") {
      check(manifest.fields.admin, admin);
      if ((admin.password ?? "") !== (admin.passwordConfirm ?? "")) {
        next.passwordConfirm = dict.passwordMismatch;
      }
    }
    if (target === "system" || target === "review") check(manifest.fields.database, database);
    if (target === "review") check(manifest.fields.system, system);

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const goNext = () => {
    const nextStep = STEP_ORDER[currentIndex + 1];
    if (!nextStep) return;
    if (!validateStep(nextStep)) return;
    setStep(nextStep);
  };

  const goPrev = () => {
    const prev = STEP_ORDER[currentIndex - 1];
    if (prev) setStep(prev);
  };

  /* --------------------------------------------------------------- 环境复检 */

  const refreshEnvironment = useCallback(async () => {
    setEnvLoading(true);
    try {
      const res = await fetch("/api/install/state", { cache: "no-store" });
      const json = (await res.json()) as { data?: { environment?: CheckItem[] } };
      if (json.data?.environment) setEnvChecks(json.data.environment);
    } catch {
      /* 复检失败保留旧结果 */
    } finally {
      setEnvLoading(false);
    }
  }, []);

  /* --------------------------------------------------------------- 测试连接 */

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/install/probe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-install-csrf": props.csrfToken },
        body: JSON.stringify({ database }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        data?: {
          database?: { ok: boolean; target: string; errorMessage?: string; hint?: string; serverVersion?: string };
          inspection?: { warnings?: string[] };
        };
      };
      const db = json.data?.database;
      if (!db) {
        setTestResult({ ok: false, target: "", message: json.message ?? "测试失败" });
        return;
      }
      setTestResult({
        ok: db.ok,
        target: db.target,
        message: db.ok ? `连接成功（${db.serverVersion ?? "未知版本"}）` : (db.errorMessage ?? "连接失败"),
        hint: db.hint,
        warnings: json.data?.inspection?.warnings,
      });
    } catch (err) {
      setTestResult({ ok: false, target: "", message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [database, props.csrfToken]);

  /* --------------------------------------------------------------- 执行安装 */

  const startInstall = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setStep("run");
    setSteps(
      Object.keys(dict.phases).map((phase) => ({
        phase: phase as StepRecord["phase"],
        status: "pending",
        startedAt: new Date().toISOString(),
      })),
    );

    try {
      const res = await fetch("/api/install/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-install-csrf": props.csrfToken },
        body: JSON.stringify({ admin, database, system }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        code?: string;
        message?: string;
        data?: RunResult;
      };

      if (!json.data) {
        setError(json.message ?? "安装请求失败");
        setRunning(false);
        return;
      }

      setResult(json.data);
      if (json.data.attempt?.steps) setSteps(json.data.attempt.steps);
      if (json.data.ok) {
        setStep("done");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [admin, database, system, props.csrfToken, dict.phases]);

  const loadLog = useCallback(async () => {
    try {
      const res = await fetch("/api/install/log?lines=300", { cache: "no-store" });
      const json = (await res.json()) as { data?: { lines: Array<Record<string, unknown>> } };
      setLogLines(json.data?.lines ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const failedChecks = useMemo(() => envChecks.filter((c) => c.status === "fail"), [envChecks]);
  const accent = manifest.project.accentColor ?? "#2563eb";

  /* --------------------------------------------------------------- 渲染 */

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex size-11 items-center justify-center rounded-xl text-base font-semibold text-white"
            style={{ backgroundColor: accent }}
            aria-hidden
          >
            {manifest.project.name.slice(0, 1)}
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {manifest.project.name} · {dict.brand}
            </h1>
            <p className="text-xs text-muted-foreground">
              v{manifest.project.version} · {dict.subtitle}
            </p>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {step === "done" ? dict.doneStep : dict.stepOf(Math.min(currentIndex + 1, STEP_ORDER.length), STEP_ORDER.length)}
        </div>
      </header>

      {/* 步骤指示器 */}
      <ol className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(
          [
            ["admin", dict.adminStep],
            ["database", dict.databaseStep],
            ["system", dict.systemStep],
            ["review", dict.reviewStep],
            ["run", dict.runStep],
          ] as Array<[WizardStep, string]>
        ).map(([key, label], index) => {
          const active = key === step;
          const done = STEP_ORDER.indexOf(step) > index || step === "done";
          return (
            <li
              key={key}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                active
                  ? "border-primary/50 bg-primary/5 font-medium"
                  : done
                    ? "border-emerald-500/30 bg-emerald-500/5 text-muted-foreground"
                    : "border-border text-muted-foreground"
              }`}
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  done ? "bg-emerald-600 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}
              >
                {done ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              <span className="truncate">{label}</span>
            </li>
          );
        })}
      </ol>

      {/* 环境检测 */}
      <section className="mb-6 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">{dict.environment}</h2>
          <button
            type="button"
            onClick={refreshEnvironment}
            disabled={envLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${envLoading ? "animate-spin" : ""}`} aria-hidden />
            {dict.refresh}
          </button>
        </div>
        <ul className="divide-y divide-border">
          {envChecks.map((check) => (
            <li key={check.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
              <span
                className={`mt-0.5 inline-flex shrink-0 rounded border px-1.5 py-0.5 font-medium ${CHECK_TONE[check.status]}`}
              >
                {dict.checks[check.status]}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-foreground">{check.title}</p>
                <p className="break-words text-muted-foreground">{check.detail}</p>
                {check.hint ? <p className="mt-0.5 text-amber-600 dark:text-amber-400">{check.hint}</p> : null}
              </div>
            </li>
          ))}
          {envChecks.length === 0 ? (
            <li className="px-4 py-3 text-xs text-muted-foreground">正在检测…</li>
          ) : null}
        </ul>
      </section>

      {failedChecks.length > 0 ? (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>有 {failedChecks.length} 项环境检测未通过，修复后才能继续安装。</span>
        </div>
      ) : null}

      {props.resumeAttempt ? (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            上次安装未完成
            {props.resumeAttempt.failedPhase ? `（失败于 ${props.resumeAttempt.failedPhase}）` : ""}：
            {props.resumeAttempt.failedMessage ?? "未知原因"}。重新提交将从中断处继续，已创建的管理员不会重复创建。
          </span>
        </div>
      ) : null}

      {/* 表单区 */}
      {step !== "run" && step !== "done" ? (
        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">
              {step === "admin"
                ? dict.adminStep
                : step === "database"
                  ? dict.databaseStep
                  : step === "system"
                    ? dict.systemStep
                    : dict.reviewStep}
            </h2>
          </div>

          <div className="grid gap-4 p-4 sm:grid-cols-2">
            {step === "admin" &&
              manifest.fields.admin.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  value={admin[field.key] ?? ""}
                  error={errors[field.key]}
                  onChange={(v) => setField("admin")(field.key, v)}
                />
              ))}

            {step === "database" && (
              <>
                {manifest.fields.database
                  .filter((f) => !f.advanced)
                  .map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={database[field.key] ?? ""}
                      error={errors[field.key]}
                      onChange={(v) => setField("database")(field.key, v)}
                    />
                  ))}
                <div className="sm:col-span-2">
                  <details className="rounded-lg border border-border bg-muted/20 p-3">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      高级：直接填连接串 / 自定义 schema
                    </summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {manifest.fields.database
                        .filter((f) => f.advanced)
                        .map((field) => (
                          <FieldInput
                            key={field.key}
                            field={field}
                            value={database[field.key] ?? ""}
                            error={errors[field.key]}
                            onChange={(v) => setField("database")(field.key, v)}
                          />
                        ))}
                    </div>
                  </details>
                </div>
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    onClick={testConnection}
                    disabled={testing}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                    {testing ? dict.testing : dict.testConnection}
                  </button>
                  {testResult ? (
                    <div
                      className={`mt-2 rounded-lg border p-2.5 text-xs ${
                        testResult.ok
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-destructive/40 bg-destructive/10 text-destructive"
                      }`}
                    >
                      <p className="font-medium">
                        {testResult.target ? `${testResult.target} — ` : ""}
                        {testResult.message}
                      </p>
                      {testResult.hint ? <p className="mt-0.5">{testResult.hint}</p> : null}
                      {testResult.warnings?.map((w) => (
                        <p key={w} className="mt-0.5 text-amber-700 dark:text-amber-300">
                          {w}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            )}

            {step === "system" &&
              manifest.fields.system.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  value={system[field.key] ?? ""}
                  error={errors[field.key]}
                  onChange={(v) => setField("system")(field.key, v)}
                />
              ))}

            {step === "review" ? (
              <div className="sm:col-span-2 space-y-3 text-xs">
                <ReviewGroup
                  title={dict.adminStep}
                  rows={manifest.fields.admin.map((f) => [
                    f.label,
                    f.secret ? "••••••••" : (admin[f.key] ?? ""),
                  ])}
                />
                <ReviewGroup
                  title={dict.databaseStep}
                  rows={[
                    ...manifest.fields.database
                      .filter((f) => !f.advanced || database[f.key])
                      .map((f) => [f.label, f.secret ? "••••••••" : (database[f.key] ?? "")] as [string, string]),
                  ]}
                />
                <ReviewGroup
                  title={dict.systemStep}
                  rows={manifest.fields.system.map((f) => [f.label, system[f.key] ?? ""])}
                />
                <p className="text-muted-foreground">
                  提交后会依次执行：检测身份 → 版本兼容 → 状态闸门 → 环境 → 参数 → 数据库 →
                  初始化条件 → 迁移 → 初始化 → 管理员 → 配置 → 写锁 → 健康检查 → 锁定入口。
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentIndex === 0}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
              {dict.prev}
            </button>

            {step === "review" ? (
              <button
                type="button"
                onClick={startInstall}
                disabled={running || failedChecks.length > 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <Play className="size-3.5" aria-hidden />
                {running ? dict.submitting : dict.submit}
              </button>
            ) : (
              <button
                type="button"
                onClick={goNext}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {dict.next}
                <ChevronRight className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
        </section>
      ) : null}

      {/* 进度 / 结果 */}
      {step === "run" || step === "done" ? (
        <section className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium">{dict.progress}</h2>
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {dict.submitting}
              </span>
            ) : result?.ok ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" aria-hidden />
                {dict.succeeded}
              </span>
            ) : null}
          </div>

          <ul className="divide-y divide-border">
            {steps.map((s) => (
              <li key={s.phase} className="flex items-start gap-3 px-4 py-2.5 text-xs">
                <span className="mt-0.5">{STATUS_ICON[s.status]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-foreground">{dict.phases[s.phase] ?? s.phase}</p>
                    <span className="shrink-0 text-muted-foreground">
                      {dict.statuses[s.status]}
                      {s.durationMs !== undefined ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ""}
                    </span>
                  </div>
                  {s.message ? (
                    <p className="mt-0.5 break-words text-muted-foreground">{s.message}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {error ? (
            <div className="border-t border-border px-4 py-3 text-xs text-destructive">{error}</div>
          ) : null}

          {result && !result.ok ? (
            <div className="border-t border-border px-4 py-3">
              <p className="text-xs font-medium text-destructive">
                {dict.failed}
                {result.attempt.error ? `：${result.attempt.error.phase}` : ""}
              </p>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {result.attempt.error?.message ?? "未知错误"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={startInstall}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                >
                  {dict.resume}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setLogOpen(true);
                    await loadLog();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                >
                  <Terminal className="size-3.5" aria-hidden />
                  {dict.showLog}
                </button>
              </div>
            </div>
          ) : null}

          {result?.ok ? (
            <div className="border-t border-border px-4 py-4">
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{dict.succeeded}</p>
              {result.config ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  运行配置已写入 <code className="rounded bg-muted px-1">{result.config.path}</code>
                  {result.config.backupPath ? `（原文件备份为 ${result.config.backupPath}）` : ""}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                安装入口已关闭。请重启服务让新配置生效，然后登录。
              </p>
              <Link
                href={result.redirectTo}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Lock className="size-3.5" aria-hidden />
                {dict.goLogin}
              </Link>
            </div>
          ) : null}

          {logOpen ? (
            <div className="border-t border-border">
              <div className="flex items-center justify-between px-4 py-2">
                <h3 className="text-xs font-medium">{dict.log}</h3>
                <button
                  type="button"
                  onClick={() => setLogOpen(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {dict.hideLog}
                </button>
              </div>
              <pre className="max-h-64 overflow-auto border-t border-border bg-muted/30 p-3 text-[11px] leading-relaxed">
                {logLines.length === 0
                  ? "（暂无日志）"
                  : logLines
                      .map((line) =>
                        typeof line.message === "string"
                          ? `${String(line.ts ?? "")} [${String(line.level ?? "info")}] ${
                              line.phase ? `${String(line.phase)}: ` : ""
                            }${line.message}`
                          : JSON.stringify(line),
                      )
                      .join("\n")}
              </pre>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

/* ------------------------------------------------------------------ 子组件 */

function defaults(fields: FieldDescriptor[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (field.default !== undefined && field.default !== null) {
      out[field.key] = String(field.default);
    } else {
      out[field.key] = "";
    }
  }
  return out;
}

function FieldInput(props: {
  field: FieldDescriptor;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { field, value, error, onChange } = props;
  const id = `install-${field.key}`;
  const describedBy = [field.help ? `${id}-help` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={field.advanced ? "" : "space-y-1"}>
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {field.label}
        {field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </label>

      {field.type === "select" ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy || undefined}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
          value={value}
          placeholder={field.placeholder}
          autoComplete={field.type === "password" ? "new-password" : "off"}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy || undefined}
          className={`w-full rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            error ? "border-destructive" : "border-border"
          }`}
        />
      )}

      {field.help && !error ? (
        <p id={`${id}-help`} className="text-[11px] text-muted-foreground">
          {field.help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ReviewGroup(props: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border border-border">
      <p className="border-b border-border px-3 py-1.5 text-xs font-medium">{props.title}</p>
      <dl className="divide-y divide-border">
        {props.rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-3 py-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="max-w-[60%] truncate text-right font-mono text-[11px]">{value || "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
