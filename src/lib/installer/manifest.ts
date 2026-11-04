/**
 * Manifest 结构校验与版本兼容检查（规格 §四）。
 *
 * 两条硬规则：
 * 1. 结构不合法 → 拒绝安装，不允许「尽力而为」地猜。
 * 2. Manifest 里不允许出现秘密。带 default 值的 secret 字段一律拒绝——
 *    因为 Manifest 会进 Git、会随包分发、会被 UI 读走。
 */
import { z } from "zod";
import {
  CONTRACT_VERSION,
  INSTALLER_VERSION,
  MANIFEST_VERSION,
  type FieldDescriptor,
  type ProjectManifest,
} from "@/lib/installer/contract";

const fieldOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

const fieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    // 只允许标识符形态，避免前端把它当表达式或 DOM 属性注入。
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "字段名必须是标识符"),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "password", "email", "number", "select", "boolean"]),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  default: z.union([z.string(), z.boolean(), z.number()]).optional(),
  placeholder: z.string().max(200).optional(),
  help: z.string().max(500).optional(),
  pattern: z.string().max(300).optional(),
  minLength: z.number().int().min(0).max(4096).optional(),
  maxLength: z.number().int().min(1).max(4096).optional(),
  options: z.array(fieldOptionSchema).max(64).optional(),
  advanced: z.boolean().optional(),
});

const fieldGroupSchema = z.object({
  admin: z.array(fieldSchema).min(1).max(40),
  database: z.array(fieldSchema).max(40),
  system: z.array(fieldSchema).max(40),
});

export const manifestSchema = z.object({
  manifestVersion: z.string().min(1),
  project: z.object({
    id: z
      .string()
      .min(1)
      .max(80)
      // 项目标识会进文件路径（/var/lib/universal-installer/<id>），必须防路径穿越。
      .regex(/^[a-z0-9][a-z0-9-]*$/, "项目标识只允许小写字母、数字与连字符"),
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(40),
    description: z.string().max(1000).optional(),
    logo: z.string().max(500).optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "主题色必须是 #RRGGBB")
      .optional(),
    homepage: z.string().max(500).optional(),
  }),
  adapter: z.string().min(1).max(80),
  requiresInstaller: z.string().min(1).max(80),
  database: z.object({
    type: z.enum(["postgresql", "mysql", "sqlite", "mongodb"]),
    minVersion: z.string().max(40).optional(),
    urlTemplate: z.string().max(500).optional(),
  }),
  fields: fieldGroupSchema,
  migration: z.object({
    engine: z.enum(["prisma", "custom", "none"]),
    path: z.string().max(500).optional(),
    backupBeforeMigrate: z.boolean().optional(),
  }),
  i18n: z.object({
    default: z.string().min(2).max(20),
    supported: z.array(z.string().min(2).max(20)).min(1).max(20),
  }),
  writablePaths: z.array(z.string().max(500)).max(20).optional(),
  successRedirect: z
    .string()
    .max(200)
    // 必须是站内路径：`//evil.com` 是协议相对 URL，浏览器会跳去外站，因此单独拦掉。
    .refine((value) => !value.startsWith("//"), "跳转路径不能是协议相对 URL")
    // 允许带 query（如 /login?next=%2Fapp），但仍必须是站内路径。
    .regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/, "跳转路径必须是站内绝对路径")
    .optional(),
});

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: ProjectManifest;
}

/** 语义化版本的最小解析：只支持 x.y.z 与可选的 -prerelease。 */
export function parseSemver(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 极简 semver range：支持空格分隔的多个约束（AND），每个约束形如
 * `>=1.0.0` / `>1.0.0` / `<=2.0.0` / `<2.0.0` / `=1.0.0` / `1.0.0`。
 * 不支持 `||`、`~`、`^`、`x`——需要时再扩展，宁可报错也不静默放过。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const current = parseSemver(version);
  if (!current) return false;

  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;

  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(part);
    if (!m) return false;
    const target = parseSemver(m[2]);
    if (!target) return false;
    const cmp = compareSemver(current, target);
    switch (m[1] ?? "=") {
      case ">=":
        if (cmp < 0) return false;
        break;
      case "<=":
        if (cmp > 0) return false;
        break;
      case ">":
        if (cmp <= 0) return false;
        break;
      case "<":
        if (cmp >= 0) return false;
        break;
      default:
        if (cmp !== 0) return false;
    }
  }
  return true;
}

const SECRET_KEY_PATTERN = /pass|secret|token|private|credential|apikey|api_key/i;

/**
 * Manifest 里不允许携带秘密。这里既查字段声明（secret 字段不许有 default），
 * 也查整份 JSON 里是否出现形似真实凭据的长串。
 */
export function findManifestSecretLeaks(manifest: ProjectManifest): string[] {
  const problems: string[] = [];

  const allFields: FieldDescriptor[] = [
    ...manifest.fields.admin,
    ...manifest.fields.database,
    ...manifest.fields.system,
  ];
  for (const field of allFields) {
    if (field.secret && field.default !== undefined && field.default !== "") {
      problems.push(`字段 ${field.key} 标记为 secret，却带了默认值`);
    }
    if (SECRET_KEY_PATTERN.test(field.key) && typeof field.default === "string" && field.default.length >= 8) {
      problems.push(`字段 ${field.key} 名字像秘密，却带了非空默认值`);
    }
  }

  const raw = JSON.stringify(manifest);
  if (/(ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/.test(raw)) {
    problems.push("Manifest 里出现了形似真实凭据的字符串");
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) {
    problems.push("Manifest 里出现了私钥块");
  }
  return problems;
}

export function validateManifest(input: unknown): ManifestValidation {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      }),
      warnings: [],
    };
  }

  const manifest = parsed.data as ProjectManifest;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    errors.push(
      `Manifest 版本 ${manifest.manifestVersion} 与本安装器支持的 ${MANIFEST_VERSION} 不一致`,
    );
  }

  if (!satisfiesRange(INSTALLER_VERSION, manifest.requiresInstaller)) {
    errors.push(
      `安装器版本 ${INSTALLER_VERSION} 不满足项目要求 ${manifest.requiresInstaller}`,
    );
  }

  if (parseSemver(manifest.project.version) === null) {
    warnings.push(`项目版本 "${manifest.project.version}" 不是标准 semver，升级比较会退化为字符串比较`);
  }

  if (!manifest.i18n.supported.includes(manifest.i18n.default)) {
    errors.push(`默认语言 ${manifest.i18n.default} 不在 supported 列表里`);
  }

  // 必填字段必须唯一，否则 UI 与校验会各取一条。
  for (const [group, fields] of Object.entries(manifest.fields)) {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) {
        errors.push(`${group} 组字段 ${field.key} 重复声明`);
      }
      seen.add(field.key);
      if (field.type === "select" && (!field.options || field.options.length === 0)) {
        errors.push(`字段 ${field.key} 是 select，但没有 options`);
      }
    }
  }

  // 数据库组必须能拼出连接串：至少要有一个形似 URL 的字段。
  const hasUrlField = manifest.fields.database.some((f) => f.key === "databaseUrl");
  const hasParts = ["host", "database", "username"].every((k) =>
    manifest.fields.database.some((f) => f.key === k),
  );
  if (!hasUrlField && !hasParts) {
    errors.push("database 组必须提供 databaseUrl，或同时提供 host/database/username");
  }

  if (manifest.migration.engine === "prisma" && !manifest.migration.path) {
    warnings.push("migration.engine=prisma 但未声明 path，将回退到 prisma/migrations");
  }

  const leaks = findManifestSecretLeaks(manifest);
  errors.push(...leaks);

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, errors: [], warnings, manifest };
}

/** 契约版本自检，供 /api/install/state 返回给前端做兼容提示。 */
export function contractInfo() {
  return {
    installerVersion: INSTALLER_VERSION,
    contractVersion: CONTRACT_VERSION,
    manifestVersion: MANIFEST_VERSION,
  };
}
