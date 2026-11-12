import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";
import { SECURITY_ALERT_THRESHOLDS } from "@/lib/config";
import {
  evaluateAuthzAlert,
  evaluateLoginAlert,
  type AuthzAlertDimension,
  type LoginAlertDimension,
} from "@/lib/domain/security-alerts";
import { emitAlert } from "@/lib/services/alerts";
import { bumpWindowCounter } from "@/lib/services/rate-limit-store";

/**
 * 登录异常与越权探测告警（阶段 6）。
 *
 * 两条链路都只「旁路观察」：
 * - 计数用 PostgreSQL 的 `rate_limit_buckets`（与公开 API 限流同一张表、同一套
 *   原子 UPSERT），不引入 Redis；
 * - 计数/审计/外发任何一步失败都吞掉并记日志，绝不让登录或业务接口失败；
 * - webhook 不 await（`emitAlert` 的 `awaitWebhook: false`），外部接收端慢
 *   不会拖住登录响应。
 *
 * 去重：同一维度（登录 IP / 登录邮箱 / 越权账号 / 越权 IP）30 分钟只告警一次。
 * 去重令牌就是 `bumpWindowCounter` 的 `count === 1`，多实例并发也只有一个赢家。
 */

export const LOGIN_BRUTEFORCE_ACTION = "auth.login_bruteforce";
export const AUTHZ_PROBING_ACTION = "authz.probing";
export const SECURITY_ALERT_ACTIONS = [LOGIN_BRUTEFORCE_ACTION, AUTHZ_PROBING_ACTION] as const;

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function claimDedupe(key: string): Promise<boolean> {
  const counter = await bumpWindowCounter(key, SECURITY_ALERT_THRESHOLDS.dedupeSeconds);
  return counter.count === 1;
}

async function resolveOrganizationForEmail(email: string): Promise<string | null> {
  const user = await prisma.users.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) return null;
  const membership = await prisma.organization_memberships.findFirst({
    where: { user_id: user.id, status: "active" },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

export interface LoginFailureInput {
  email: string;
  ip: string | null;
  requestId?: string | null;
  userAgent?: string | null;
}

/**
 * 记录一次登录失败（401 或限流 429 都算）。
 *
 * 为什么 429 也要算：登录限流是 5 分钟 8 次，第 9 次开始返回 429；如果只统计
 * 401，攻击者被限流后就永远到不了「10 次失败」的告警阈值，等于攻击越猛越安静。
 */
export async function observeLoginFailure(input: LoginFailureInput): Promise<void> {
  try {
    const email = normalizeEmail(input.email);
    const ip = input.ip ?? "unknown";
    const emailHash = sha256Short(email);
    const windowSeconds = SECURITY_ALERT_THRESHOLDS.loginWindowSeconds;

    const [ipCounter, emailCounter] = await Promise.all([
      bumpWindowCounter(`alert:login:ip:${ip}`, windowSeconds),
      bumpWindowCounter(`alert:login:email:${emailHash}`, windowSeconds),
    ]);
    await bumpWindowCounter(`alert:login:email-ip:${emailHash}:${ip}`, windowSeconds);

    // 只数当前窗口内仍有效的 email-ip 行：过期行留着但不代表最近 10 分钟。
    const distinctIps = await prisma.rate_limit_buckets.count({
      where: {
        bucket_key: { startsWith: `alert:login:email-ip:${emailHash}:` },
        expires_at: { gt: new Date() },
      },
    });

    const dimensions = evaluateLoginAlert({
      ipFailures: ipCounter.count,
      emailFailures: emailCounter.count,
      distinctIps,
    });
    if (dimensions.length === 0) return;

    const claimed: LoginAlertDimension[] = [];
    if (dimensions.includes("ip") && (await claimDedupe(`alert:dedupe:login:ip:${ip}`))) {
      claimed.push("ip");
    }
    if (
      dimensions.includes("email") &&
      (await claimDedupe(`alert:dedupe:login:email:${emailHash}`))
    ) {
      claimed.push("email");
    }
    if (claimed.length === 0) return;

    const organizationId = await resolveOrganizationForEmail(email);
    const now = new Date().toISOString();
    const summary =
      `登录失败告警（${claimed.join("+")}）：IP ${ip} 在 ${windowSeconds / 60} 分钟内失败 ` +
      `${ipCounter.count} 次，邮箱 ${email} 失败 ${emailCounter.count} 次，来源 IP ${distinctIps} 个`;

    await emitAlert({
      audit: organizationId
        ? {
            organizationId,
            actorType: "system",
            actorId: null,
            action: LOGIN_BRUTEFORCE_ACTION,
            resourceType: "admin_session",
            resourceId: null,
            after: {
              trigger: claimed.join("+"),
              ip,
              email,
              ip_failures: ipCounter.count,
              email_failures: emailCounter.count,
              distinct_ips: distinctIps,
              window_seconds: windowSeconds,
            },
            requestId: input.requestId ?? null,
            ip: input.ip,
            userAgent: input.userAgent ?? null,
          }
        : null,
      logTag: "[security][alert]",
      logMessage: summary,
      awaitWebhook: false,
      webhookBody: {
        event: LOGIN_BRUTEFORCE_ACTION,
        severity: "warning",
        occurred_at: now,
        environment: process.env.DEPLOYMENT_ENV ?? "development",
        organization_id: organizationId,
        dimensions: {
          trigger: claimed.join("+"),
          ip,
          email,
          failures: ipCounter.count,
          email_failures: emailCounter.count,
          distinct_ips: distinctIps,
          window_seconds: windowSeconds,
        },
        message: summary,
        request_id: input.requestId ?? null,
      },
    });
  } catch (error) {
    console.error("[security][alert] 登录失败告警处理异常", error);
  }
}

export interface AuthzFailureInput {
  organizationId: string;
  userId: string;
  userEmail: string;
  ip: string | null;
  status: number;
  method: string;
  path: string;
  requestId?: string | null;
  userAgent?: string | null;
}

/**
 * 记录一次管理接口 403 或跨租户 404。
 *
 * 403 覆盖「权限不足」「CSRF 失败」，404 覆盖「资源不存在或不属于当前组织」。
 * 登录失败（401）不走这里：那是认证问题，已有登录告警链路。
 */
export async function observeAuthzFailure(input: AuthzFailureInput): Promise<void> {
  try {
    const ip = input.ip ?? "unknown";
    const windowSeconds = SECURITY_ALERT_THRESHOLDS.authzWindowSeconds;
    const [actorCounter, ipCounter] = await Promise.all([
      bumpWindowCounter(`alert:authz:actor:${input.userId}`, windowSeconds),
      bumpWindowCounter(`alert:authz:ip:${ip}`, windowSeconds),
    ]);

    const dimensions = evaluateAuthzAlert({
      actorEvents: actorCounter.count,
      ipEvents: ipCounter.count,
    });
    if (dimensions.length === 0) return;

    const claimed: AuthzAlertDimension[] = [];
    if (
      dimensions.includes("actor") &&
      (await claimDedupe(`alert:dedupe:authz:actor:${input.userId}`))
    ) {
      claimed.push("actor");
    }
    if (dimensions.includes("ip") && (await claimDedupe(`alert:dedupe:authz:ip:${ip}`))) {
      claimed.push("ip");
    }
    if (claimed.length === 0) return;

    const now = new Date().toISOString();
    const summary =
      `越权探测告警（${claimed.join("+")}）：${input.userEmail} 在 ${windowSeconds / 60} 分钟内 ` +
      `触发 ${input.status} 共 ${actorCounter.count} 次（IP ${ip} 共 ${ipCounter.count} 次），` +
      `最近一次 ${input.method} ${input.path}`;

    await emitAlert({
      audit: {
        organizationId: input.organizationId,
        actorType: "admin",
        actorId: input.userId,
        action: AUTHZ_PROBING_ACTION,
        resourceType: "admin_api",
        resourceId: null,
        after: {
          trigger: claimed.join("+"),
          status: input.status,
          method: input.method,
          path: input.path,
          actor_events: actorCounter.count,
          ip_events: ipCounter.count,
          window_seconds: windowSeconds,
          ip,
          email: input.userEmail,
        },
        requestId: input.requestId ?? null,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
      },
      logTag: "[security][alert]",
      logMessage: summary,
      awaitWebhook: false,
      webhookBody: {
        event: AUTHZ_PROBING_ACTION,
        severity: "warning",
        occurred_at: now,
        environment: process.env.DEPLOYMENT_ENV ?? "development",
        organization_id: input.organizationId,
        dimensions: {
          trigger: claimed.join("+"),
          admin_user_id: input.userId,
          email: input.userEmail,
          ip,
          status: input.status,
          events: actorCounter.count,
          ip_events: ipCounter.count,
          window_seconds: windowSeconds,
        },
        message: summary,
        request_id: input.requestId ?? null,
      },
    });
  } catch (error) {
    console.error("[security][alert] 越权告警处理异常", error);
  }
}
