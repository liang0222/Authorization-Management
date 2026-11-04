/**
 * 安装流水线编排（规格 §五 的 18 步 + §八 状态机 + §六 互斥与恢复）。
 *
 * 一次 runInstall() 就是一次「安装尝试（attempt）」：
 *   - 先拿互斥锁，拿不到直接拒绝（两人同时访问时第二个人会看到明确的拒绝信息）；
 *   - 每一步都先落盘状态再执行，因此进程被杀也能从 attempt 记录看出断在哪；
 *   - 任一步失败 → 状态进 FAILED，attempt 保留，下次可用 resume 重放；
 *   - 全部成功 → 写安装锁 + 写数据库记录 → 状态进 INSTALLED → 安装入口永久关闭。
 *
 * 所有步骤都必须是幂等的：恢复时会把它们从头再跑一遍。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  InstallAttempt,
  InstallPhase,
  InstallSnapshot,
  InstallerAdapter,
  InstallerConfigInput,
  StepRecord,
} from "@/lib/installer/contract";
import { INSTALLER_VERSION } from "@/lib/installer/contract";
import { probeEnvironment } from "@/lib/installer/env-probe";
import { acquireInstallLock, InstallLockBusyError } from "@/lib/installer/lock";
import { buildDatabaseUrl, inspectDatabase, parseDatabaseUrl, describeTarget, withClient } from "@/lib/installer/database";
import { runPrismaMigrate } from "@/lib/installer/migrations";
import { writeRuntimeConfig, generateSecret, readEnvFile } from "@/lib/installer/config-writer";
import { canRunInstall, describeState } from "@/lib/installer/state";
import {
  appendLog,
  buildSnapshot,
  ensureDir,
  projectDataDir,
  readState,
  redact,
  transitionState,
  writeAttempt,
  writeLock,
} from "@/lib/installer/store";
import { validateManifest } from "@/lib/installer/manifest";

export interface RunInstallOptions {
  adapter: InstallerAdapter;
  projectDir: string;
  input: InstallerConfigInput;
  /** 恢复上一次失败的尝试（保留 adminEmail 约束）。 */
  resume?: boolean;
  /** 覆盖数据根目录（测试用）；默认走 INSTALLER_DATA_DIR。 */
  dataDir?: string;
  /** 运行配置输出路径；默认 /etc/licensing-saas/production.env。 */
  configPath?: string;
  /** 只做检测不落任何状态（dry-run，用于 UI 预览）。 */
  dryRun?: boolean;
}

export interface RunInstallResult {
  ok: boolean;
  attempt: InstallAttempt;
  snapshot: InstallSnapshot;
  config?: { path: string; keys: string[]; backupPath?: string };
  /** 安装完成后应跳转的站内路径。 */
  redirectTo: string;
}

export class InstallBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallBusyError";
  }
}

export class InstallRefusedError extends Error {
  constructor(
    message: string,
    readonly state: string,
  ) {
    super(message);
    this.name = "InstallRefusedError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 从表单拼出连接串：优先用用户直接给的 databaseUrl。 */
/**
 * 拼装连接串。实现只有一份（core 的 buildDatabaseUrl），这里只负责在缺字段时
 * 抛一个带上下文的错误，避免「拼串逻辑两处漂移」这种经典事故。
 */
export function resolveDatabaseUrl(input: InstallerConfigInput): string {
  const url = buildDatabaseUrl(input);
  if (!url) {
    throw new Error("数据库连接信息不完整：需要 host、database、username（或直接填 databaseUrl）");
  }
  return url;
}

/** 读取当前安装状态（不拿锁、不写任何东西，供页面与 API 用）。 */
export async function readSnapshot(options: {
  adapter: InstallerAdapter;
  projectDir: string;
  /** 表单还没提交时，用进程环境里的连接串做探测。 */
  databaseUrl?: string;
}): Promise<InstallSnapshot> {
  const manifest = await options.adapter.getManifest();
  const dir = projectDataDir(manifest.project.id);

  // 探测既有安装：只读，不建表。
  let probe: { installed: boolean; evidence: string[] } | null = null;
  const envUrl = options.databaseUrl ?? process.env.LICENSE_DB_URL;
  if (envUrl) {
    try {
      const parsed = parseDatabaseUrl(envUrl);
      const inspection = await inspectDatabase({ admin: {}, database: { databaseUrl: parsed.raw }, system: {} });
      probe = {
        installed: inspection.hasBusinessData,
        evidence: [
          `${inspection.tableCount} 张表`,
          inspection.hasBusinessData ? "organizations 有数据" : "organizations 为空",
        ],
      };
    } catch {
      probe = null;
    }
  } else {
    probe = null;
  }

  // 数据库里的安装记录：installer_records 是安装器自己的表，核心可以直接读。
  let dbRecord: { installedAt: string; projectVersion: string } | null = null;
  if (envUrl) {
    try {
      const rows = await withClient(envUrl, async (client) => {
        const exists = await client.query<{ count: string }>(
          "select count(*)::text as count from information_schema.tables where table_schema='public' and table_name='installer_records'",
        );
        if (Number(exists.rows[0]?.count ?? 0) === 0) return [];
        const { rows: found } = await client.query<{ project_version: string; installed_at: Date }>(
          "select project_version, installed_at from installer_records where project_id = $1 limit 1",
          [manifest.project.id],
        );
        return found;
      });
      const row = rows[0];
      if (row) {
        dbRecord = {
          installedAt: new Date(row.installed_at).toISOString(),
          projectVersion: row.project_version,
        };
      }
    } catch {
      // 读不到不算错：锁文件与探测仍然能给出结论。
      dbRecord = null;
    }
  }

  return buildSnapshot(dir, {
    projectId: manifest.project.id,
    projectVersion: manifest.project.version,
    probe,
    dbRecord,
  });
}

/** 第 8 步：把表单按 Manifest 的字段描述校验一遍（不碰数据库）。 */
export function validateForm(
  manifest: Awaited<ReturnType<InstallerAdapter["getManifest"]>>,
  input: InstallerConfigInput,
): { ok: boolean; issues: Array<{ field: string; message: string }> } {
  const issues: Array<{ field: string; message: string }> = [];

  const check = (group: keyof typeof manifest.fields, values: Record<string, unknown>) => {
    for (const field of manifest.fields[group]) {
      const raw = values[field.key];
      const missing = raw === undefined || raw === null || String(raw).trim() === "";

      if (field.required && missing) {
        issues.push({ field: field.key, message: `${field.label} 不能为空` });
        continue;
      }
      if (missing) continue;

      const text = String(raw);
      if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        issues.push({ field: field.key, message: `${field.label} 不是合法邮箱` });
      }
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(text)) {
            issues.push({ field: field.key, message: `${field.label} 格式不符合要求` });
          }
        } catch {
          issues.push({ field: field.key, message: `字段 ${field.key} 的正则本身有误，请联系项目维护者` });
        }
      }
      if (field.minLength !== undefined && text.length < field.minLength) {
        issues.push({ field: field.key, message: `${field.label} 至少 ${field.minLength} 个字符` });
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        issues.push({ field: field.key, message: `${field.label} 最多 ${field.maxLength} 个字符` });
      }
      if (field.type === "select" && field.options && !field.options.some((o) => o.value === text)) {
        issues.push({ field: field.key, message: `${field.label} 的取值不在允许范围内` });
      }
    }
  };

  check("admin", input.admin);
  check("database", input.database);
  check("system", input.system);

  // 跨字段：两次密码一致
  const pw = String(input.admin.password ?? "");
  const pw2 = String(input.admin.passwordConfirm ?? "");
  if (pw && pw2 && pw !== pw2) {
    issues.push({ field: "passwordConfirm", message: "两次输入的密码不一致" });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 主流程。
 */
export async function runInstall(options: RunInstallOptions): Promise<RunInstallResult> {
  const manifestValidation = validateManifest(await options.adapter.getManifest());
  if (!manifestValidation.ok || !manifestValidation.manifest) {
    throw new InstallRefusedError(
      `Manifest 校验未通过：${manifestValidation.errors.join("；")}`,
      "MANIFEST_INVALID",
    );
  }
  const manifest = manifestValidation.manifest;
  const projectId = manifest.project.id;
  const dir = options.dataDir ?? projectDataDir(projectId);
  ensureDir(dir);

  /* ---------------- 第 3 步：状态闸门 ---------------- */
  const current = await readSnapshot({
    adapter: options.adapter,
    projectDir: options.projectDir,
    // 逐项填写时也要能探测到既有安装，所以统一走 buildDatabaseUrl。
    databaseUrl: buildDatabaseUrl(options.input) || undefined,
  });

  if (!canRunInstall(current.state)) {
    throw new InstallRefusedError(
      `当前状态为「${describeState(current.state)}」，安装入口已关闭。${current.reason}`,
      current.state,
    );
  }
  if (current.tampered) {
    appendLog(dir, {
      level: "warn",
      message: "检测到安装锁异常（校验和不符或缺失），但状态为已安装，拒绝重新安装",
    });
  }

  /* ---------------- 互斥锁 ---------------- */
  let held: ReturnType<typeof acquireInstallLock> | null = null;
  if (!options.dryRun) {
    try {
      held = acquireInstallLock(dir);
    } catch (error) {
      if (error instanceof InstallLockBusyError) {
        throw new InstallBusyError(error.message);
      }
      throw error;
    }
  }

  const previous = readState(dir);
  const attempt: InstallAttempt = {
    id: randomUUID(),
    startedAt: nowIso(),
    status: "running",
    adminEmail: options.resume ? previous?.adminEmail : undefined,
    steps: [],
  };

  const log = (message: string, detail?: Record<string, unknown>) => {
    appendLog(dir, { level: "info", message, detail });
  };

  const setStep = (phase: InstallPhase, patch: Partial<StepRecord>) => {
    const existing = attempt.steps.find((s) => s.phase === phase);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      attempt.steps.push({
        phase,
        status: "pending",
        startedAt: nowIso(),
        ...patch,
      } as StepRecord);
    }
    if (!options.dryRun) writeAttempt(dir, attempt);
  };

  /** 执行一步：落盘 running → 执行 → 落盘 ok/failed。 */
  const step = async <T>(
    phase: InstallPhase,
    fn: () => Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }>,
  ): Promise<void> => {
    held?.heartbeat();
    setStep(phase, { status: "running", startedAt: nowIso() });
    appendLog(dir, { level: "info", phase, message: "开始" });
    const started = Date.now();
    try {
      const result = await fn();
      setStep(phase, {
        status: result.ok ? "ok" : "failed",
        finishedAt: nowIso(),
        durationMs: Date.now() - started,
        message: redact(result.message),
        detail: result.detail,
      });
      appendLog(dir, {
        level: result.ok ? "info" : "error",
        phase,
        message: result.message,
        detail: result.detail,
      });
      if (!result.ok) {
        throw new StepFailure(phase, result.message);
      }
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      const message = redact((error as Error).message ?? String(error));
      setStep(phase, {
        status: "failed",
        finishedAt: nowIso(),
        durationMs: Date.now() - started,
        message,
      });
      appendLog(dir, { level: "error", phase, message });
      throw new StepFailure(phase, message);
    } finally {
      held?.heartbeat();
    }
  };

  let configResult: { path: string; keys: string[]; backupPath?: string } | undefined;
  let redirectTo = manifest.successRedirect ?? "/login";
  /** 表单解析出的连接串；失败分支也要用它重新判定状态，否则会误判成「别人的既有安装」。 */
  let resolvedUrl = "";

  try {
    if (!options.dryRun) {
      /*
       * FAILED 不能直接进 INSTALLING（状态机里 FAILED 只能进 RECOVERY）。
       * 「失败后点继续」是规格明确要求的场景，所以这里先落 RECOVERY 再进 INSTALLING，
       * 让转移路径与状态表一致，而不是绕过状态机。
       */
      if (current.state === "FAILED") {
        transitionState(dir, projectId, "FAILED", "RECOVERY", {
          projectVersion: manifest.project.version,
          lastAttemptId: attempt.id,
          reason: "准备从上次失败处恢复安装",
        });
      }
      transitionState(dir, projectId, current.state === "INSTALLED" ? "UNINSTALLED" : current.state === "FAILED" ? "RECOVERY" : current.state, "INSTALLING", {
        projectVersion: manifest.project.version,
        lastAttemptId: attempt.id,
        reason: options.resume ? "从上次失败处恢复安装" : "开始安装",
      });
    }

    /* 1. 检测项目身份 */
    await step("identity", async () => {
      const detected = await options.adapter.detect();
      return {
        ok: true,
        message: detected.detected
          ? `识别到项目（${detected.evidence.join("；")}）`
          : `识别到项目：${manifest.project.name}`,
        detail: { evidence: detected.evidence, projectVersion: detected.projectVersion },
      };
    });

    /* 2. 检查安装器版本 */
    await step("installer-version", async () => ({
      ok: true,
      message: `安装器 ${INSTALLER_VERSION} / 契约 ${manifestValidation.manifest?.manifestVersion} / 要求 ${manifest.requiresInstaller}`,
      detail: { warnings: manifestValidation.warnings },
    }));

    /* 3. 检查项目安装状态（已在上方闸门完成，这里只记录结论） */
    await step("install-state", async () => ({
      ok: true,
      message: `安装前状态：${describeState(current.state)}（${current.reason}）`,
      detail: { source: current.source, tampered: current.tampered },
    }));

    /* 4. 检测服务器环境 */
    await step("environment", async () => {
      const checks = await probeEnvironment({
        projectDir: options.projectDir,
        dataDir: dir,
        writablePaths: manifest.writablePaths,
      });
      const failed = checks.filter((c) => c.status === "fail");
      const warned = checks.filter((c) => c.status === "warn");
      return {
        ok: failed.length === 0,
        message:
          failed.length > 0
            ? `环境检测未通过：${failed.map((c) => `${c.title}（${c.detail}）`).join("；")}`
            : `环境检测通过（${checks.length} 项，${warned.length} 项警告）`,
        detail: { checks },
      };
    });

    /* 5-7 表单已在 UI 收集；8. 校验参数 */
    let databaseUrl = "";
    await step("validate", async () => {
      const formResult = validateForm(manifest, options.input);
      const adapterResult = await options.adapter.validateConfig(options.input);
      const issues = [...formResult.issues, ...adapterResult.issues];
      if (issues.length > 0) {
        return {
          ok: false,
          message: `参数校验失败：${issues.map((i) => `${i.field} ${i.message}`).join("；")}`,
          detail: { issues },
        };
      }
      databaseUrl = resolveDatabaseUrl(options.input);
      resolvedUrl = databaseUrl;
      return {
        ok: true,
        message: "参数校验通过",
        detail: { databaseTarget: describeTarget(parseDatabaseUrl(databaseUrl)) },
      };
    });

    /* 9. 测试数据库连接 */
    await step("database", async () => {
      const result = await options.adapter.testDatabase(options.input);
      return {
        ok: result.ok,
        message: result.ok
          ? `连接成功：${result.target}（${result.serverVersion ?? "未知版本"}，${result.latencyMs ?? 0}ms）`
          : `连接失败：${result.errorMessage ?? "未知错误"}${result.hint ? `｜建议：${result.hint}` : ""}`,
        detail: {
          target: result.target,
          serverVersion: result.serverVersion,
          latencyMs: result.latencyMs,
          errorCode: result.errorCode,
        },
      };
    });

    /* 10. 检查数据库初始化条件 */
    let hasExistingTables = false;
    await step("db-precondition", async () => {
      const inspection = await options.adapter.inspectDatabase(options.input);
      hasExistingTables = inspection.tableCount > 0;
      const blocking = !inspection.canCreate;
      return {
        ok: !blocking,
        message: blocking
          ? `数据库用户缺少 CREATE 权限${inspection.warnings.length ? `；${inspection.warnings.join("；")}` : ""}`
          : `库内 ${inspection.tableCount} 张表，已应用 ${inspection.appliedMigrations} 个迁移${
              inspection.warnings.length ? `；注意：${inspection.warnings.join("；")}` : ""
            }`,
        detail: { ...inspection },
      };
    });

    const ctx: AdapterContext = {
      dataDir: dir,
      projectDir: options.projectDir,
      input: options.input,
      databaseUrl,
      log,
    };

    /* 11. 执行迁移 */
    await step("migrate", async () => {
      const result = await options.adapter.runMigrations({ ...ctx, databaseUrl });
      /*
       * Prisma 的报错原文很长（带 DbError 调试结构），原样抛给用户既难读也暴露内部细节。
       * 这里把「可诊断 + 可行动」的部分挑出来：错误码、ERROR 行、HINT 行。
       */
      const message = result.ok ? result.message : explainMigrationFailure(result.message);
      return {
        ok: result.ok,
        message,
        detail: {
          applied: result.applied,
          alreadyApplied: result.alreadyApplied.length,
          backup: result.backup?.status,
          backupPath: result.backup?.path,
        },
      };
    });

    /* 12. 项目初始化任务 */
    await step("initialize", async () => {
      const result = await options.adapter.initialize({ ...ctx, databaseUrl });
      return {
        ok: result.ok,
        message: result.message,
        detail: { tasks: result.tasks },
      };
    });

    /* 13. 创建管理员 */
    await step("admin", async () => {
      const email = String(options.input.admin.email ?? "").trim().toLowerCase();
      // 恢复时不允许换人：否则会凭空多出一个管理员。
      if (attempt.adminEmail && attempt.adminEmail !== email) {
        return {
          ok: false,
          message: `上次安装已创建管理员 ${attempt.adminEmail}，恢复时不允许更换为 ${email}`,
        };
      }
      const result = await options.adapter.createAdmin({ ...ctx, databaseUrl });
      if (result.ok) {
        attempt.adminEmail = result.email;
        if (!options.dryRun) writeAttempt(dir, attempt);
      }
      return {
        ok: result.ok,
        message: result.message,
        detail: { email: result.email, alreadyExisted: result.alreadyExisted },
      };
    });

    /* 14. 保存运行配置 */
    await step("config", async () => {
      if (options.dryRun) {
        return { ok: true, message: "演练模式：跳过配置写入" };
      }
      const configPath =
        options.configPath ?? process.env.INSTALLER_ENV_FILE ?? "/etc/licensing-saas/production.env";

      // 已存在的键一律保留（避免覆盖运维手工改过的值），只补缺失的。
      const existing = readEnvFile(configPath);
      const values: Record<string, string> = { ...existing };

      values.LICENSE_DB_URL = databaseUrl;
      values.NODE_ENV = "production";
      values.DEPLOYMENT_ENV = values.DEPLOYMENT_ENV ?? "production";
      values.APP_BASE_URL = values.APP_BASE_URL ?? String(options.input.system.appBaseUrl ?? "http://127.0.0.1:3000");
      values.SIGNING_KEY_DIR = values.SIGNING_KEY_DIR ?? ".keys-prod";
      values.BACKUP_LOCAL_DIR = values.BACKUP_LOCAL_DIR ?? ".backups-prod";
      values.DEV_MAIL_SINK = values.DEV_MAIL_SINK ?? "false";
      values.ASSERTION_AUDIENCE = values.ASSERTION_AUDIENCE ?? "license-api";
      values.LICENSE_HMAC_PEPPER_VERSION = values.LICENSE_HMAC_PEPPER_VERSION ?? "v2";
      values.LICENSE_HMAC_PEPPER_LEGACY =
        values.LICENSE_HMAC_PEPPER_LEGACY ?? "dev-only-license-hmac-pepper-please-change-in-production";
      values.LICENSE_HMAC_PEPPER_LEGACY_VERSION = values.LICENSE_HMAC_PEPPER_LEGACY_VERSION ?? "v1";

      const generated: string[] = [];
      for (const key of [
        "SESSION_SECRET",
        "SECRETBOX_KEY",
        "LICENSE_HMAC_PEPPER",
        "BACKUP_ENCRYPTION_KEY",
        "METRICS_TOKEN",
      ]) {
        if (!values[key]) {
          values[key] = generateSecret();
          generated.push(key);
        }
      }

      const written = writeRuntimeConfig({ path: configPath, values });
      configResult = { path: written.path, keys: written.keys, backupPath: written.backupPath };
      return {
        ok: true,
        message: `已写入 ${written.path}（${written.keys.length} 个键，${written.bytes} 字节）${
          written.backupPath ? `，原文件备份为 ${written.backupPath}` : ""
        }${generated.length ? `；新生成密钥：${generated.join("、")}（请另行离线备份）` : ""}`,
        detail: { path: written.path, keys: written.keys, generated, backupPath: written.backupPath },
      };
    });

    /* 15. 写入安装完成状态 */
    await step("finalize", async () => {
      if (options.dryRun) {
        return { ok: true, message: "演练模式：不写安装锁" };
      }
      const installedAt = nowIso();
      writeLock(dir, {
        projectId,
        projectVersion: manifest.project.version,
        installerVersion: INSTALLER_VERSION,
        installedAt,
        recordId: attempt.id,
        adopted: false,
      });
      transitionState(dir, projectId, "INSTALLING", "INSTALLED", {
        projectVersion: manifest.project.version,
        installedAt,
        lastAttemptId: attempt.id,
        adminEmail: attempt.adminEmail,
        adopted: false,
        tampered: false,
        reason: "安装完成",
      });

      // 数据库安装记录（规格 §六：本地状态与数据库记录共同校验）。
      // 表不存在或写失败都不回滚安装：本地锁是权威，这里只是第二份证据。
      let recordNote = "";
      if (options.adapter.recordInstall) {
        try {
          await options.adapter.recordInstall(
            { ...ctx, databaseUrl },
            {
              projectId,
              projectVersion: manifest.project.version,
              installerVersion: INSTALLER_VERSION,
              adapter: manifest.adapter,
              manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
              attemptId: attempt.id,
              installedBy: attempt.adminEmail,
              detail: { steps: attempt.steps.map((s) => ({ phase: s.phase, status: s.status })) },
            },
          );
          recordNote = "，数据库安装记录已写入";
        } catch (error) {
          recordNote = `，数据库安装记录写入失败（${redact((error as Error).message)}）`;
          appendLog(dir, { level: "warn", phase: "finalize", message: recordNote });
        }
      }

      return {
        ok: true,
        message: `安装锁已写入，状态置为已安装（${installedAt}）${recordNote}`,
        detail: { dataDir: dir, dbRecord: recordNote.length > 0 },
      };
    });

    /* 16. 最终健康检查 */
    await step("healthcheck", async () => {
      const result = await options.adapter.healthCheck({ ...ctx, databaseUrl });
      return {
        ok: result.ok,
        message: result.message,
        detail: { checks: result.checks },
      };
    });

    /* 17. 锁定安装入口（幂等复核：确认状态与锁都在） */
    await step("lockdown", async () => {
      const snap = await readSnapshot({
        adapter: options.adapter,
        projectDir: options.projectDir,
        databaseUrl,
      });
      const locked = snap.state === "INSTALLED";
      return {
        ok: locked,
        message: locked ? `安装入口已关闭（状态 ${describeState(snap.state)}）` : "安装入口未能关闭，请检查安装锁",
        detail: { state: snap.state, source: snap.source },
      };
    });

    attempt.status = "succeeded";
    attempt.finishedAt = nowIso();
    if (!options.dryRun) writeAttempt(dir, attempt);

    /* 18. 跳转 */
    redirectTo = manifest.successRedirect ?? "/login";

    const snapshot = await readSnapshot({
      adapter: options.adapter,
      projectDir: options.projectDir,
      databaseUrl,
    });

    return { ok: true, attempt, snapshot, config: configResult, redirectTo };
  } catch (error) {
    const failure =
      error instanceof StepFailure
        ? error
        : new StepFailure("identity", redact((error as Error).message ?? String(error)));

    attempt.status = "failed";
    attempt.finishedAt = nowIso();
    attempt.error = { phase: failure.phase, message: failure.message };

    if (!options.dryRun) {
      writeAttempt(dir, attempt);
      try {
        const stored = readState(dir);
        transitionState(dir, projectId, stored?.state ?? "INSTALLING", "FAILED", {
          projectVersion: manifest.project.version,
          lastAttemptId: attempt.id,
          adminEmail: attempt.adminEmail,
          reason: `安装失败于「${failure.phase}」：${failure.message}`,
        });
      } catch {
        /* 状态机不允许时保持原状，attempt 里已有记录 */
      }
      appendLog(dir, {
        level: "error",
        phase: failure.phase,
        message: `安装失败：${failure.message}`,
      });
    }

    const snapshot = await readSnapshot({
      adapter: options.adapter,
      projectDir: options.projectDir,
      databaseUrl: resolvedUrl || undefined,
    });

    return { ok: false, attempt, snapshot, redirectTo };
  } finally {
    held?.release();
  }
}

class StepFailure extends Error {
  constructor(
    readonly phase: InstallPhase,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

/**
 * 把 Prisma migrate 的冗长报错压成「错误码 + 关键行 + 处置建议」。
 * 认不出的错误原样返回，不丢信息。
 */
export function explainMigrationFailure(raw: string): string {
  // migrations.ts 已经带了「迁移失败：」前缀，这里统一剥掉，避免出现「迁移失败：迁移失败：」。
  const text = raw.replace(/^迁移失败[：:]\s*/, "").trim();

  // Prisma 自己的错误码（P3009 = 库里有失败的历史迁移记录）
  const prismaCode = /Error:\s*(P\d{4})/.exec(text)?.[1];
  if (prismaCode === "P3009") {
    const failedName = /The `([^`]+)` migration started at ([^\n]+?) failed/.exec(text);
    return [
      "迁移失败（Prisma P3009）：目标库里有一条「开始了但没跑完」的迁移记录，Prisma 因此拒绝继续",
      failedName ? `失败迁移：${failedName[1]}（开始于 ${failedName[2].trim()}）` : undefined,
      "处置：确认该迁移确实没生效后，执行 `npx prisma migrate resolve --rolled-back <迁移名>` 把它标为回滚，再重试安装；若库里已有半成品对象，先清理或换空库",
    ]
      .filter(Boolean)
      .join("；");
  }

  const code = /Database error code:\s*(\d{5})/.exec(text)?.[1];
  const errorLine = /ERROR:\s*(.+)/.exec(text)?.[1]?.trim();
  const hint = /HINT:\s*(.+)/.exec(text)?.[1]?.trim();

  const advice: Record<string, string> = {
    "42501": "数据库用户权限不足。建表需要 schema 的 CREATE；迁移里的 CREATE EXTENSION 需要数据库级 CREATE，或让 DBA 预装该扩展。",
    "28P01": "用户名或密码错误。",
    "3D000": "目标数据库不存在。",
    "42P07": "对象已存在，可能是库里已有同名表；确认库名是否正确。",
    "53300": "数据库连接数已满。",
  };

  if (!code && !errorLine) return `迁移失败：${text}`;

  const parts = [`迁移失败${code ? `（SQLSTATE ${code}）` : ""}`];
  if (errorLine) parts.push(errorLine);
  if (hint) parts.push(`提示：${hint}`);
  if (code && advice[code]) parts.push(advice[code]);
  return parts.join("；");
}

export { StepFailure };
