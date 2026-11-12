/**
 * 本项目（授权管理 SaaS）的 Project Manifest。
 *
 * 规格 §四要求 Manifest 描述「安装需要什么」，UI 完全由它驱动，
 * 因此这里既是文档也是唯一事实来源（没有第二份 JSON 需要同步）。
 *
 * 注意：任何 secret 字段都不允许带默认值，validateManifest() 会拦。
 */
import type { ProjectManifest } from "../../contract";

export const LICENSING_SAAS_PROJECT_ID = "licensing-saas";

export const licensingSaasManifest: ProjectManifest = {
  manifestVersion: "1.0",
  project: {
    id: LICENSING_SAAS_PROJECT_ID,
    name: "授权管理平台",
    version: "1.5.0",
    description:
      "软件授权签发、激活校验与异地备份一体化的授权管理系统。安装向导会创建数据库表、初始化权限与角色、生成签名密钥并建立第一个管理员账号。",
    accentColor: "#2563eb",
  },
  adapter: "licensing-saas",
  requiresInstaller: ">=1.0.0 <2.0.0",
  database: {
    type: "postgresql",
    minVersion: "14",
    urlTemplate: "postgresql://{username}:{password}@{host}:{port}/{database}?schema={schema}",
  },
  fields: {
    admin: [
      {
        key: "email",
        label: "管理员邮箱",
        type: "email",
        required: true,
        placeholder: "owner@example.com",
        help: "用于登录后台，安装完成后不可通过向导修改",
        maxLength: 254,
      },
      {
        key: "displayName",
        label: "显示名称",
        type: "text",
        required: true,
        default: "所有者",
        maxLength: 120,
      },
      {
        key: "password",
        label: "登录密码",
        type: "password",
        required: true,
        secret: true,
        minLength: 10,
        maxLength: 200,
        help: "至少 10 位，且必须同时包含字母与数字",
      },
      {
        key: "passwordConfirm",
        label: "确认密码",
        type: "password",
        required: true,
        secret: true,
        minLength: 10,
        maxLength: 200,
      },
    ],
    database: [
      {
        key: "host",
        label: "主机",
        type: "text",
        required: true,
        default: "127.0.0.1",
        placeholder: "127.0.0.1",
        maxLength: 255,
      },
      {
        key: "port",
        label: "端口",
        type: "number",
        required: true,
        default: 5432,
        placeholder: "5432",
      },
      {
        key: "database",
        label: "数据库名",
        type: "text",
        required: true,
        placeholder: "licensing",
        maxLength: 63,
        help: "该库必须已存在；安装器不会替你 CREATE DATABASE",
      },
      {
        key: "username",
        label: "用户名",
        type: "text",
        required: true,
        placeholder: "licensing",
        maxLength: 63,
      },
      {
        key: "password",
        label: "密码",
        type: "password",
        secret: true,
        maxLength: 200,
        help: "留空表示无密码（仅限 trust 认证的本地库）",
      },
      {
        key: "schema",
        label: "Schema",
        type: "text",
        default: "public",
        advanced: true,
        maxLength: 63,
      },
      {
        key: "databaseUrl",
        label: "直接填连接串",
        type: "text",
        secret: true,
        advanced: true,
        placeholder: "postgresql://user:pass@host:5432/db?schema=public",
        help: "填了这里就忽略上面的分项；密码含特殊字符时更推荐用这一项",
        maxLength: 2000,
      },
    ],
    system: [
      {
        key: "organizationName",
        label: "组织名称",
        type: "text",
        required: true,
        default: "我的组织",
        maxLength: 160,
      },
      {
        key: "organizationSlug",
        label: "组织标识",
        type: "text",
        required: true,
        default: "default",
        pattern: "^[a-z0-9][a-z0-9-]{1,79}$",
        maxLength: 80,
        help: "小写字母、数字与连字符，2-80 位，用于 URL 与 API 路径",
      },
      {
        key: "timezone",
        label: "时区",
        type: "text",
        default: "Asia/Shanghai",
        maxLength: 64,
      },
      {
        key: "appBaseUrl",
        label: "站点访问地址",
        type: "text",
        required: true,
        default: "http://127.0.0.1:3000",
        placeholder: "https://license.example.com",
        maxLength: 500,
        help: "写进运行配置的 APP_BASE_URL，用于生成绝对链接与校验回调来源",
      },
      {
        key: "signingKeyDir",
        label: "签名密钥目录",
        type: "text",
        default: ".keys-prod",
        maxLength: 200,
        help: "相对项目根目录；安装器会在这里生成第一把 Ed25519 签名私钥",
      },
      {
        key: "deploymentEnv",
        label: "部署环境",
        type: "select",
        default: "production",
        options: [
          { value: "production", label: "生产（production）" },
          { value: "sandbox", label: "沙箱（sandbox）" },
          { value: "development", label: "开发（development）" },
        ],
      },
    ],
  },
  migration: {
    engine: "prisma",
    path: "prisma/migrations",
    backupBeforeMigrate: true,
  },
  i18n: {
    default: "zh-CN",
    supported: ["zh-CN", "en-US"],
  },
  writablePaths: [".keys-prod", ".backups-prod"],
  successRedirect: "/login",
};
