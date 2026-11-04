/**
 * Universal Installer — Installer Contract（安装器契约）
 *
 * 这一层是「通用核心」与「具体项目」之间唯一的耦合面。核心不知道项目用什么框架、
 * 什么语言、几张表；项目也不知道核心把状态存在哪、UI 长什么样。
 *
 * 设计约束（来自规格 §三、§四、§六）：
 * - 核心不得 import 任何项目业务代码。本文件只允许 import Node 内置模块与 zod。
 * - 契约是数据契约（JSON 可序列化），因此换语言实现适配器时可以用
 *   stdin/stdout 或本地 HTTP 承载同一份 payload。
 * - 任何会被写进日志或返回给浏览器的结构里都不允许出现明文秘密。
 */

export const INSTALLER_VERSION = "1.0.0";
export const CONTRACT_VERSION = "1.0";
export const MANIFEST_VERSION = "1.0";

/** 规格 §八：状态机的六个状态。 */
export type InstallState =
  | "UNINSTALLED"
  | "INSTALLING"
  | "INSTALLED"
  | "MAINTENANCE"
  | "FAILED"
  | "RECOVERY"
  /** 不是状态机里的状态，而是「无法判定」：本地无锁、数据库也连不上。 */
  | "UNKNOWN";

/** 状态是从哪一条证据得出的。用于前端展示与审计，不参与状态机。 */
export type StateSource = "lock" | "database" | "adopted" | "probe" | "default";

/** 规格 §五的 18 步，收敛为 14 个可执行阶段（表单 3 步在 UI 侧，不占服务端步骤）。 */
export type InstallPhase =
  | "identity"
  | "installer-version"
  | "install-state"
  | "environment"
  | "validate"
  | "database"
  | "db-precondition"
  | "migrate"
  | "initialize"
  | "admin"
  | "config"
  | "finalize"
  | "healthcheck"
  | "lockdown";

export const INSTALL_PHASES: readonly InstallPhase[] = [
  "identity",
  "installer-version",
  "install-state",
  "environment",
  "validate",
  "database",
  "db-precondition",
  "migrate",
  "initialize",
  "admin",
  "config",
  "finalize",
  "healthcheck",
  "lockdown",
] as const;

export type StepStatus = "pending" | "running" | "ok" | "skipped" | "failed";

export interface StepRecord {
  phase: InstallPhase;
  status: StepStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** 展示给人看的一句话结论。绝不允许包含密码。 */
  message?: string;
  /** 结构化补充信息（行数、版本号、耗时等），同样不含秘密。 */
  detail?: Record<string, unknown>;
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckItem {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** 修复建议，前端直接展示。 */
  hint?: string;
}

/* ------------------------------------------------------------------ 表单字段 */

export type FieldType = "text" | "password" | "email" | "number" | "select" | "boolean";

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * Manifest 里的字段描述。UI 完全由它驱动，因此「加一个配置项」不需要改 UI 代码。
 * `secret: true` 的字段在日志、状态文件、API 响应里一律脱敏。
 */
export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  secret?: boolean;
  default?: string | boolean | number;
  placeholder?: string;
  help?: string;
  /** 正则字符串，服务端与前端共用同一份。 */
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  options?: FieldOption[];
  /** 数据库字段专用：是否允许用户覆盖（例如 dbUrl 允许手填，端口不允许）。 */
  advanced?: boolean;
}

export interface FieldGroup {
  admin: FieldDescriptor[];
  database: FieldDescriptor[];
  system: FieldDescriptor[];
}

/* -------------------------------------------------------------------- Manifest */

export interface ManifestProject {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 相对项目根的路径或绝对路径；核心只做展示，不读取。 */
  logo?: string;
  accentColor?: string;
  homepage?: string;
}

export interface ManifestDatabase {
  /** 只声明「适配器支持什么」，核心据此决定展示哪些连接字段。 */
  type: "postgresql" | "mysql" | "sqlite" | "mongodb";
  minVersion?: string;
  /** 连接串必填项；默认 host/port/database/username/password。 */
  urlTemplate?: string;
}

export interface ManifestMigration {
  /** 适配器沿用哪套迁移引擎。本项目用 prisma，核心不再自造一套。 */
  engine: "prisma" | "custom" | "none";
  path?: string;
  /** 迁移前是否要求备份；有既有数据时核心会尝试 pg_dump。 */
  backupBeforeMigrate?: boolean;
}

export interface ManifestI18n {
  default: string;
  supported: string[];
}

export interface ProjectManifest {
  manifestVersion: string;
  project: ManifestProject;
  adapter: string;
  /** semver range，例如 ">=1.0.0 <2.0.0"。 */
  requiresInstaller: string;
  database: ManifestDatabase;
  fields: FieldGroup;
  migration: ManifestMigration;
  i18n: ManifestI18n;
  /** 环境检测里需要额外确认可写的路径（相对项目根或绝对路径）。 */
  writablePaths?: string[];
  /** 安装完成后跳转的相对路径。 */
  successRedirect?: string;
}

/* --------------------------------------------------------------- 安装输入输出 */

export interface InstallerConfigInput {
  admin: Record<string, string>;
  database: Record<string, string>;
  system: Record<string, string | boolean | number>;
}

export interface ValidationIssue {
  /** 对应 FieldDescriptor.key，UI 用它把错误挂到具体输入框。 */
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface DatabaseTestResult {
  ok: boolean;
  /** 已经脱敏的连接描述，例如 licensing@127.0.0.1:55432/licensing */
  target: string;
  serverVersion?: string;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hint?: string;
}

export interface DatabaseInspection {
  ok: boolean;
  /** public schema 下的用户表数量。 */
  tableCount: number;
  /** 是否是本项目的库（存在 _prisma_migrations 或核心业务表）。 */
  looksLikeProject: boolean;
  /** 已应用的迁移数量（读 _prisma_migrations）。 */
  appliedMigrations: number;
  /** 是否存在业务数据（organizations/users 有行）。 */
  hasBusinessData: boolean;
  /** 对当前用户是否有 CREATE 权限。 */
  canCreate: boolean;
  /** 危险提示：库里有别人的表。 */
  warnings: string[];
}

export interface MigrationResult {
  ok: boolean;
  applied: string[];
  alreadyApplied: string[];
  backup?: {
    status: "created" | "skipped" | "failed";
    path?: string;
    bytes?: number;
    reason?: string;
  };
  message: string;
}

export interface InitializeResult {
  ok: boolean;
  /** 逐项初始化任务的执行情况，用于幂等恢复时判断哪些已经做过。 */
  tasks: Array<{ id: string; status: "created" | "skipped" | "failed"; message: string }>;
  message: string;
}

export interface AdminResult {
  ok: boolean;
  userId?: string;
  email: string;
  /** true 表示这次没有新建（恢复场景下已经存在）。 */
  alreadyExisted: boolean;
  message: string;
}

export interface HealthResult {
  ok: boolean;
  checks: CheckItem[];
  message: string;
}

/* ------------------------------------------------------------------ 适配器 */

/** 适配器执行时的运行上下文。核心负责构造，适配器只读。 */
export interface AdapterContext {
  /** 该项目专属的数据目录（已确保存在、0700）。 */
  dataDir: string;
  /** 项目根目录（Next.js 进程的 cwd）。 */
  projectDir: string;
  /** 表单提交的原始输入。 */
  input: InstallerConfigInput;
  /** 从 database 字段拼出的连接串（已校验、已编码）。 */
  databaseUrl: string;
  /** 写一行安装日志；核心负责脱敏与落盘。 */
  log: (message: string, detail?: Record<string, unknown>) => void;
  /** 取消信号，超时或用户中断时触发。 */
  signal?: AbortSignal;
}

/** 项目自身「是否已经装过」的探测结果，用于自适配既有实例。 */
export interface DetectResult {
  detected: boolean;
  /** 探测依据，例如「41 张表、1 个组织、3 个用户」。 */
  evidence: string[];
  projectVersion?: string;
}

/**
 * 统一生命周期接口（规格 §三）。顺序即核心的调用顺序。
 * 每个方法都必须是幂等的：恢复流程会重放失败步骤之后的所有步骤。
 */
export interface InstallerAdapter {
  readonly id: string;

  /** 1. 识别当前项目。 */
  detect(): Promise<DetectResult>;

  /** Manifest 由适配器提供，核心负责校验与版本兼容检查。 */
  getManifest(): Promise<ProjectManifest>;

  /** 8. 校验表单参数（不碰数据库）。 */
  validateConfig(input: InstallerConfigInput): Promise<ValidationResult>;

  /** 9. 测试数据库连接。 */
  testDatabase(input: InstallerConfigInput): Promise<DatabaseTestResult>;

  /** 10. 检查数据库初始化条件（是否已有数据、是否有建表权限）。 */
  inspectDatabase(input: InstallerConfigInput): Promise<DatabaseInspection>;

  /** 11. 执行项目迁移。 */
  runMigrations(ctx: AdapterContext): Promise<MigrationResult>;

  /** 12. 项目初始化任务（权限、角色、组织等）。 */
  initialize(ctx: AdapterContext): Promise<InitializeResult>;

  /** 13. 创建管理员。必须拒绝覆盖已存在的管理员。 */
  createAdmin(ctx: AdapterContext): Promise<AdminResult>;

  /** 16. 最终健康检查。 */
  healthCheck(ctx: AdapterContext): Promise<HealthResult>;

  /**
   * 可选：把安装记录写进项目自己的数据库（规格 §六「本地持久化状态和数据库
   * 安装记录共同校验」）。核心不认识项目的表结构，因此这一步交给适配器；
   * 适配器没有实现时核心只依赖本地安装锁。
   */
  recordInstall?(ctx: AdapterContext, record: InstallRecord): Promise<void>;
}

/** 写进项目数据库的安装记录。字段名与 installer_records 表一致。 */
export interface InstallRecord {
  projectId: string;
  projectVersion: string;
  installerVersion: string;
  adapter: string;
  manifestSha256: string;
  attemptId: string;
  installedBy?: string;
  detail?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ 快照 */

/** 安装尝试的持久化记录。恢复流程读它来决定从哪一步继续。 */
export interface InstallAttempt {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "aborted";
  /** 已创建管理员的邮箱。恢复时不允许换人。 */
  adminEmail?: string;
  steps: StepRecord[];
  error?: { phase: InstallPhase; message: string };
}

export interface InstallSnapshot {
  state: InstallState;
  source: StateSource;
  projectId: string;
  projectVersion?: string;
  installerVersion: string;
  installedAt?: string;
  /** 已装但锁文件校验不过 / 锁被删但库里有记录 → true。 */
  tampered: boolean;
  /** 自适配既有实例（不是通过安装器装的）。 */
  adopted: boolean;
  reason: string;
  attempt?: InstallAttempt;
}
