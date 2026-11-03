import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { ApiError, okResponse, readJson } from "@/lib/http/api";
import { writeAudit } from "@/lib/domain/audit";

/**
 * 组织级系统设置（规格 15.4“系统管理 / 系统设置”）。
 *
 * 设计决策：
 * - settings 存在 organizations.settings（JSONB），这里维护一份“可编辑项白名单”：
 *   GET 返回系统默认值 + 每项的类型/范围/说明，PATCH 只接受白名单键并做范围校验，
 *   未设置过的键在运行时回落到默认值。
 * - 写入使用 PostgreSQL 的 `settings || patch::jsonb` 做真正的 JSONB 合并，
 *   避免“先读后写”覆盖其他管理员同时修改的键。
 * - 数值型配置一律做整数 + 上下界校验，避免把 0 或负数写进保留天数/重试次数。
 */

const DEFAULTS = {
  apiRequestLogRetentionDays: 30,
  auditLogRetentionDays: 180,
  defaultSessionTtlHours: 8,
  webhookMaxRetries: 6,
  allowPublicCredentialRotation: true,
} as const;

type SettingKey = keyof typeof DEFAULTS;
type SettingType = "integer" | "boolean";

interface SettingDefinition {
  key: SettingKey;
  type: SettingType;
  label: string;
  description: string;
  defaultValue: number | boolean;
  /** 数值型配置的取值范围；布尔型没有范围 */
  min?: number;
  max?: number;
  unit?: string;
}

const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "apiRequestLogRetentionDays",
    type: "integer",
    label: "API 请求日志保留天数",
    description: "验证日志（api_request_logs）的保留天数，超期记录由清理任务删除。",
    defaultValue: DEFAULTS.apiRequestLogRetentionDays,
    min: 1,
    max: 365,
    unit: "天",
  },
  {
    key: "auditLogRetentionDays",
    type: "integer",
    label: "操作审计保留天数",
    description: "审计日志（audit_logs）的保留天数；合规场景建议不低于 180 天。",
    defaultValue: DEFAULTS.auditLogRetentionDays,
    min: 30,
    max: 3650,
    unit: "天",
  },
  {
    key: "defaultSessionTtlHours",
    type: "integer",
    label: "默认会话有效期",
    description: "新建管理会话的默认有效小时数；成员被停用或会话到期后立即失效。",
    defaultValue: DEFAULTS.defaultSessionTtlHours,
    min: 1,
    max: 168,
    unit: "小时",
  },
  {
    key: "webhookMaxRetries",
    type: "integer",
    label: "Webhook 最大重试次数",
    description: "Webhook 投递失败后的最大重试次数，超过后标记为 dead。",
    defaultValue: DEFAULTS.webhookMaxRetries,
    min: 0,
    max: 20,
    unit: "次",
  },
  {
    key: "allowPublicCredentialRotation",
    type: "boolean",
    label: "允许公开凭证自助轮换",
    description: "是否允许 public_client 类型凭证自助轮换密钥；关闭后仅管理员可轮换。",
    defaultValue: DEFAULTS.allowPublicCredentialRotation,
  },
];

const patchSchema = z.strictObject({
  apiRequestLogRetentionDays: z.number().int("保留天数必须是整数").optional(),
  auditLogRetentionDays: z.number().int("保留天数必须是整数").optional(),
  defaultSessionTtlHours: z.number().int("会话有效期必须是整数").optional(),
  webhookMaxRetries: z.number().int("重试次数必须是整数").optional(),
  allowPublicCredentialRotation: z.boolean("必须是布尔值").optional(),
});

function readRawSettings(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

export async function GET(req: NextRequest) {
  return withAdmin(req, "settings:read", async ({ session, requestId }) => {
    const organization = await prisma.organizations.findFirst({
      where: { id: session.organization.id },
      select: { settings: true, updated_at: true },
    });
    if (!organization) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "组织不存在");
    }

    const raw = readRawSettings(organization.settings);
    const overrides: Record<string, unknown> = {};
    const effective: Record<string, unknown> = { ...DEFAULTS };
    for (const definition of SETTING_DEFINITIONS) {
      const value = raw[definition.key];
      if (value !== undefined) {
        overrides[definition.key] = value;
        effective[definition.key] = value;
      }
    }

    return okResponse(
      {
        /** 数据库里真实保存的 settings JSON（可能包含白名单之外的扩展键） */
        settings: raw,
        /** 白名单内已显式覆盖的键 */
        overrides,
        /** 默认值 + 覆盖值合并后的实际生效值 */
        effectiveSettings: effective,
        defaults: DEFAULTS,
        /** 可编辑项定义：类型、范围、默认值与说明 */
        fields: SETTING_DEFINITIONS,
        updatedAt: organization.updated_at.toISOString(),
      },
      requestId,
    );
  });
}

export async function PATCH(req: NextRequest) {
  return withAdmin(req, "settings:write", async ({ session, requestId, ip, userAgent }) => {
    const organizationId = session.organization.id;
    const body = await readJson(req, patchSchema);

    const patch: Partial<Record<SettingKey, number | boolean>> = {};
    for (const definition of SETTING_DEFINITIONS) {
      const value = body[definition.key];
      if (value === undefined) continue;

      if (definition.type === "integer") {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          const message = `${definition.label}必须是整数`;
          throw new ApiError(400, "INVALID_REQUEST", message, {
            fieldErrors: { [definition.key]: message },
          });
        }
        if (definition.min !== undefined && value < definition.min) {
          const message = `${definition.label}不能小于 ${definition.min}`;
          throw new ApiError(400, "INVALID_REQUEST", message, {
            fieldErrors: { [definition.key]: message },
          });
        }
        if (definition.max !== undefined && value > definition.max) {
          const message = `${definition.label}不能大于 ${definition.max}`;
          throw new ApiError(400, "INVALID_REQUEST", message, {
            fieldErrors: { [definition.key]: message },
          });
        }
      } else if (typeof value !== "boolean") {
        const message = `${definition.label}必须是布尔值`;
        throw new ApiError(400, "INVALID_REQUEST", message, {
          fieldErrors: { [definition.key]: message },
        });
      }

      patch[definition.key] = value;
    }

    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", "没有可更新的设置项");
    }

    const before = await prisma.organizations.findFirst({
      where: { id: organizationId },
      select: { settings: true },
    });
    if (!before) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "组织不存在");
    }
    const beforeSettings = readRawSettings(before.settings);
    const afterSettings = { ...beforeSettings, ...patch };

    // JSONB 合并：只覆盖提交的键，其他键（含未来新增键）保持原值
    const affected = await prisma.$executeRaw`
      UPDATE organizations
      SET settings = settings || ${JSON.stringify(patch)}::jsonb,
          updated_at = now()
      WHERE id = ${organizationId}::uuid
    `;
    if (affected === 0) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "组织不存在");
    }

    await writeAudit({
      organizationId,
      actorType: "admin",
      actorId: session.user.id,
      action: "settings.update",
      resourceType: "organization",
      resourceId: organizationId,
      before: { settings: beforeSettings },
      after: { settings: afterSettings },
      requestId,
      ip,
      userAgent,
    });

    return okResponse(
      {
        updated: true,
        settings: afterSettings,
        changed: patch,
        updatedAt: new Date().toISOString(),
      },
      requestId,
    );
  });
}
