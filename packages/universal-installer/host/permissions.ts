/**
 * 权限码表与角色预设（宿主口径的副本）
 *
 * 来源：Authorization-Management（原仓本文件 src/lib/domain/permissions.ts）@ 提交 d38c077（阶段 3 拆分时抄录）。
 * 这是**逐字复制**，不是重新实现：安装器要创建管理员账号、写角色与权限，
 * 必须与宿主项目口径完全一致（scrypt 参数、口令策略、权限码表）。
 * 改动规则：宿主侧改了这里就要跟着改，两边内容必须保持一致；构建期没有联动检查。
 */
/**
 * RBAC 权限目录（规格 2.3-A、15.4）。
 *
 * 权限码同时用于：导航可见性、按钮可用性、API 授权检查。
 * 导航隐藏不是权限控制本身——每个 API 路由都会再次校验。
 */

export interface PermissionDefinition {
  code: string;
  description: string;
  group: string;
}

export const PERMISSIONS: PermissionDefinition[] = [
  { code: "dashboard:read", description: "查看工作台数据总览", group: "工作台" },

  { code: "product:read", description: "查看软件产品", group: "业务管理" },
  { code: "product:write", description: "创建/修改软件产品", group: "业务管理" },
  { code: "customer:read", description: "查看客户", group: "业务管理" },
  { code: "customer:write", description: "创建/修改客户", group: "业务管理" },
  { code: "plan:read", description: "查看授权套餐", group: "业务管理" },
  { code: "plan:write", description: "创建/修改授权套餐", group: "业务管理" },
  { code: "feature:read", description: "查看功能权限定义", group: "业务管理" },
  { code: "feature:write", description: "创建/修改功能权限定义", group: "业务管理" },
  { code: "license:read", description: "查看授权与兑换码", group: "业务管理" },
  { code: "license:issue", description: "签发授权/批量生成", group: "业务管理" },
  { code: "license:renew", description: "续费授权", group: "业务管理" },
  { code: "license:suspend", description: "暂停/恢复授权", group: "业务管理" },
  { code: "license:revoke", description: "撤销授权", group: "业务管理" },
  { code: "license:rekey", description: "重发兑换码/重置激活次数", group: "业务管理" },
  { code: "activation:read", description: "查看激活设备", group: "业务管理" },
  { code: "activation:release", description: "解绑设备", group: "业务管理" },
  { code: "activation:block", description: "禁用/恢复设备", group: "业务管理" },

  { code: "credential:read", description: "查看 API 凭证", group: "开发者中心" },
  { code: "credential:write", description: "创建/轮换/禁用 API 凭证", group: "开发者中心" },
  { code: "webhook:read", description: "查看 Webhook 配置与投递", group: "开发者中心" },
  { code: "webhook:write", description: "创建/修改/重放 Webhook", group: "开发者中心" },

  { code: "signingkey:read", description: "查看签名密钥", group: "安全审计" },
  { code: "signingkey:write", description: "生成/轮换/吊销签名密钥", group: "安全审计" },
  { code: "verification:read", description: "查看验证日志", group: "安全审计" },
  { code: "audit:read", description: "查看操作审计", group: "安全审计" },

  { code: "member:read", description: "查看管理员与角色", group: "系统管理" },
  { code: "member:write", description: "邀请/停用管理员，调整角色", group: "系统管理" },
  { code: "org:read", description: "查看组织设置", group: "系统管理" },
  { code: "org:write", description: "修改组织设置", group: "系统管理" },
  { code: "settings:read", description: "查看系统设置", group: "系统管理" },
  { code: "settings:write", description: "修改系统设置", group: "系统管理" },

  { code: "backup:read", description: "查看备份目标、策略与作业", group: "系统管理" },
  { code: "backup:write", description: "配置存储目标、发起备份、重传与校验", group: "系统管理" },
  { code: "backup:restore", description: "执行隔离恢复演练与生产恢复", group: "系统管理" },
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

export type PermissionCode = string;

export interface RolePreset {
  code: string;
  name: string;
  description: string;
  permissions: PermissionCode[];
}

const READ_ONLY = ALL_PERMISSION_CODES.filter((code) => code.endsWith(":read"));

const OPERATOR_EXTRA = [
  "license:issue",
  "license:renew",
  "license:suspend",
  "license:rekey",
  "activation:release",
  "activation:block",
];

export const ROLE_PRESETS: RolePreset[] = [
  {
    code: "owner",
    name: "所有者",
    description: "组织创建者，拥有全部权限且不可被移除",
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: "admin",
    name: "管理员",
    description: "除组织所有权转移外的全部运维权限",
    permissions: ALL_PERMISSION_CODES.filter((code) => code !== "org:write"),
  },
  {
    code: "operator",
    name: "运营",
    description: "日常发码、续费、暂停与设备解绑，不能撤销授权或管理密钥",
    permissions: Array.from(new Set([...READ_ONLY, ...OPERATOR_EXTRA])),
  },
  {
    code: "viewer",
    name: "只读",
    description: "只读账号，用于客服与审计查看",
    permissions: [...READ_ONLY],
  },
];

export function permissionsForRoleCodes(codes: string[]): Set<string> {
  const set = new Set<string>();
  for (const preset of ROLE_PRESETS) {
    if (codes.includes(preset.code)) {
      preset.permissions.forEach((permission) => set.add(permission));
    }
  }
  return set;
}

/** 导航项声明：路由 + 所需权限 + 分组（Sidebar 与移动端导航共用）。 */
export interface NavItem {
  label: string;
  href: string;
  permission: PermissionCode;
  /** 子路径高亮：详情页也应点亮父级导航 */
  matchPrefixes?: string[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "工作台",
    items: [{ label: "数据总览", href: "/app/dashboard", permission: "dashboard:read" }],
  },
  {
    title: "业务管理",
    items: [
      { label: "软件产品", href: "/app/products", permission: "product:read", matchPrefixes: ["/app/products/"] },
      { label: "客户管理", href: "/app/customers", permission: "customer:read" },
      { label: "授权套餐", href: "/app/plans", permission: "plan:read" },
      { label: "功能权限", href: "/app/features", permission: "feature:read" },
      { label: "授权管理", href: "/app/licenses", permission: "license:read", matchPrefixes: ["/app/licenses/"] },
      { label: "激活设备", href: "/app/devices", permission: "activation:read", matchPrefixes: ["/app/devices/"] },
    ],
  },
  {
    title: "开发者中心",
    items: [
      { label: "API 接入", href: "/app/developer/api", permission: "product:read" },
      { label: "API 凭证", href: "/app/developer/credentials", permission: "credential:read" },
      { label: "Webhook", href: "/app/developer/webhooks", permission: "webhook:read" },
      // 用量就是请求日志的聚合视图，因此沿用验证日志的只读权限，不新增权限码。
      { label: "用量分析", href: "/app/developer/usage", permission: "verification:read" },
    ],
  },
  {
    title: "安全审计",
    items: [
      { label: "签名密钥", href: "/app/security/signing-keys", permission: "signingkey:read" },
      { label: "验证日志", href: "/app/security/verification-logs", permission: "verification:read" },
      { label: "操作审计", href: "/app/security/audit-logs", permission: "audit:read" },
    ],
  },
  {
    title: "系统管理",
    items: [
      { label: "管理员与角色", href: "/app/settings/members", permission: "member:read" },
      { label: "角色与权限", href: "/app/settings/roles", permission: "member:read" },
      { label: "组织设置", href: "/app/settings/organization", permission: "org:read" },
      { label: "系统设置", href: "/app/settings/system", permission: "settings:read" },
      { label: "备份与灾备", href: "/app/settings/backups", permission: "backup:read" },
    ],
  },
];
