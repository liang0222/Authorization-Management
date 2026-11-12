/**
 * 安装向导的多语言词典（规格 Layer 3「多语言」）。
 *
 * 只覆盖安装向导自身的文案。字段的 label/help 来自 Manifest（项目自己提供），
 * 因此接入新项目不需要改这里。
 */
export type InstallLocale = "zh-CN" | "en-US";

export interface InstallDictionary {
  brand: string;
  subtitle: string;
  stepOf: (current: number, total: number) => string;
  next: string;
  prev: string;
  submit: string;
  submitting: string;
  retry: string;
  resume: string;
  refresh: string;
  testConnection: string;
  testing: string;
  locked: string;
  lockedHint: string;
  unknown: string;
  unknownHint: string;
  adopted: string;
  tampered: string;
  environment: string;
  adminStep: string;
  databaseStep: string;
  systemStep: string;
  reviewStep: string;
  runStep: string;
  doneStep: string;
  progress: string;
  log: string;
  showLog: string;
  hideLog: string;
  succeeded: string;
  failed: string;
  goLogin: string;
  requiredField: string;
  passwordMismatch: string;
  checks: Record<string, string>;
  statuses: Record<string, string>;
  phases: Record<string, string>;
}

const zh: InstallDictionary = {
  brand: "安装向导",
  subtitle: "按步骤完成部署。每一步都会真实验证，不会跳过。",
  stepOf: (c, t) => `第 ${c} / ${t} 步`,
  next: "下一步",
  prev: "上一步",
  submit: "开始安装",
  submitting: "正在安装…",
  retry: "重试",
  resume: "从中断处恢复",
  refresh: "重新检测",
  testConnection: "测试数据库连接",
  testing: "正在测试…",
  locked: "安装入口已关闭",
  lockedHint: "本项目已经安装完成。如需重新部署，请先按运维手册卸载并清理安装状态。",
  unknown: "无法判断安装状态",
  unknownHint: "数据库当前不可连接。为避免覆盖既有数据，安装入口已锁定。请先恢复数据库再刷新本页。",
  adopted: "检测到既有安装",
  tampered: "安装状态异常",
  environment: "环境检测",
  adminStep: "管理员账号",
  databaseStep: "数据库连接",
  systemStep: "系统配置",
  reviewStep: "确认信息",
  runStep: "执行安装",
  doneStep: "安装完成",
  progress: "安装进度",
  log: "安装日志",
  showLog: "展开日志",
  hideLog: "收起日志",
  succeeded: "全部步骤已完成",
  failed: "安装失败",
  goLogin: "前往登录",
  requiredField: "此项必填",
  passwordMismatch: "两次输入的密码不一致",
  checks: { ok: "通过", warn: "警告", fail: "失败" },
  statuses: {
    pending: "等待中",
    running: "进行中",
    ok: "完成",
    skipped: "已跳过",
    failed: "失败",
  },
  phases: {
    identity: "检测项目身份",
    "installer-version": "检查安装器版本",
    "install-state": "检查安装状态",
    environment: "检测服务器环境",
    validate: "验证配置参数",
    database: "测试数据库连接",
    "db-precondition": "检查数据库初始化条件",
    migrate: "创建数据表 / 执行迁移",
    initialize: "执行项目初始化",
    admin: "创建管理员账号",
    config: "保存运行配置",
    finalize: "写入安装完成状态",
    healthcheck: "最终健康检查",
    lockdown: "锁定安装入口",
  },
};

const en: InstallDictionary = {
  brand: "Setup Wizard",
  subtitle: "Complete the deployment step by step. Every step is really verified.",
  stepOf: (c, t) => `Step ${c} of ${t}`,
  next: "Next",
  prev: "Back",
  submit: "Start installation",
  submitting: "Installing…",
  retry: "Retry",
  resume: "Resume from failure",
  refresh: "Re-check",
  testConnection: "Test connection",
  testing: "Testing…",
  locked: "Installer is locked",
  lockedHint: "This project is already installed. To redeploy, uninstall and clear the installer state first.",
  unknown: "Install state unknown",
  unknownHint:
    "The database is unreachable. To avoid overwriting existing data the installer is locked. Restore the database and refresh.",
  adopted: "Existing installation detected",
  tampered: "Install state anomaly",
  environment: "Environment checks",
  adminStep: "Administrator",
  databaseStep: "Database",
  systemStep: "System",
  reviewStep: "Review",
  runStep: "Install",
  doneStep: "Done",
  progress: "Progress",
  log: "Log",
  showLog: "Show log",
  hideLog: "Hide log",
  succeeded: "All steps completed",
  failed: "Installation failed",
  goLogin: "Go to sign in",
  requiredField: "Required",
  passwordMismatch: "Passwords do not match",
  checks: { ok: "OK", warn: "Warning", fail: "Failed" },
  statuses: { pending: "Pending", running: "Running", ok: "Done", skipped: "Skipped", failed: "Failed" },
  phases: {
    identity: "Detect project",
    "installer-version": "Check installer version",
    "install-state": "Check install state",
    environment: "Probe environment",
    validate: "Validate configuration",
    database: "Test database",
    "db-precondition": "Inspect database",
    migrate: "Run migrations",
    initialize: "Initialize project",
    admin: "Create administrator",
    config: "Save runtime config",
    finalize: "Write install lock",
    healthcheck: "Health check",
    lockdown: "Lock installer",
  },
};

export const INSTALL_DICTIONARIES: Record<InstallLocale, InstallDictionary> = {
  "zh-CN": zh,
  "en-US": en,
};

export function dictionaryFor(locale: string): InstallDictionary {
  return INSTALL_DICTIONARIES[(locale as InstallLocale) in INSTALL_DICTIONARIES ? (locale as InstallLocale) : "zh-CN"];
}
