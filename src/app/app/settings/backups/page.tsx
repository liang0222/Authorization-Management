"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Cloud,
  DatabaseBackup,
  HardDrive,
  Loader2,
  Lock,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader, Section, InfoGrid } from "@/components/app/page-header";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { EmptyState } from "@/components/app/feedback";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { formatDateTime, formatRelative, humanBytes, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 系统运维 · 备份与灾备（规格 16.10）。
 *
 * 这一页的设计取舍：
 * 1. **不提供「点击即覆盖生产库」**。规格明确要求生产恢复必须 Owner + MFA + 二次确认 + 输入短语，
 *    当前版本只提供隔离恢复演练（恢复进临时库 → 对账 → 删库），恢复出厂能力属于 P1，
 *    页面上把这条限制写出来，比放一个危险的按钮更负责。
 * 2. **凭证永不回显**。目标表单只在「新增/轮换」时接收凭证，读取时只有 `credentialConfigured`。
 * 3. **状态机照实展示**。作业状态有 succeeded / partial / degraded / failed 四种，
 *    degraded 的语义是「必备份成功、备目标失败」，和 failed 完全不是一回事，颜色与文案必须区分。
 */

type ProviderType = "local" | "s3" | "webdav" | "sftp";
type TargetMode = "all_required" | "primary_then_fallback" | "quorum";
type CredentialKind = "access_key" | "username_password" | "ssh_key";

interface Destination {
  id: string;
  name: string;
  providerType: ProviderType;
  adapterType: string;
  endpointUrl: string | null;
  region: string | null;
  bucket: string | null;
  rootPath: string | null;
  remotePrefix: string | null;
  authMethod: string;
  credentialConfigured: boolean;
  tlsVerify: boolean;
  enabled: boolean;
  priority: number;
  isRequired: boolean;
  capabilitySnapshot: Record<string, boolean>;
  lastTestedAt: string | null;
  lastTestStatus: "untested" | "passed" | "failed";
  lastTestErrorCode: string | null;
  lastTestError: string | null;
}

interface PolicyTarget {
  destinationId: string;
  name: string;
  providerType: ProviderType;
  priority: number;
  isRequired: boolean;
}

interface Policy {
  id: string;
  name: string;
  scope: string;
  scheduleCron: string;
  timezone: string;
  targetMode: TargetMode;
  requiredSuccessCount: number | null;
  retention: { daily?: number; weekly?: number; monthly?: number } | null;
  verifyMode: string;
  bandwidthLimitKbps: number | null;
  parallelism: number;
  encrypt: boolean;
  enabled: boolean;
  targets: PolicyTarget[];
}

interface JobTarget {
  id: string;
  destinationId: string;
  destinationName: string;
  providerType: ProviderType;
  status: "queued" | "uploading" | "uploaded" | "verifying" | "verified" | "failed" | "skipped";
  remoteUri: string | null;
  remoteSizeBytes: number | null;
  checksumSha256: string | null;
  uploadedAt: string | null;
  verifiedAt: string | null;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface Job {
  id: string;
  backupId: string;
  policyId: string | null;
  policyName: string | null;
  status: "queued" | "running" | "partial" | "degraded" | "succeeded" | "failed";
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  manifestSha256: string | null;
  hasLocalStaging: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  targets: JobTarget[];
}

interface RestoreTest {
  id: string;
  jobId: string | null;
  backupId: string | null;
  status: "queued" | "running" | "passed" | "failed";
  testEnvironment: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  rpoSeconds: number | null;
  rtoSeconds: number | null;
  errorMessage: string | null;
  createdAt: string;
}

interface Overview {
  targets: { rpoSeconds: number; rtoSeconds: number };
  measured: { rpoSeconds: number | null; rtoSeconds: number | null };
  lastSuccess: { id: string; backupId: string; finishedAt: string | null; sizeBytes: number | null } | null;
  lastFailure: { id: string; backupId: string; errorCode: string | null; errorMessage: string | null } | null;
  lastVerifiedAt: string | null;
  lastRestoreTest: { id: string; status: string; finishedAt: string | null; rtoSeconds: number | null } | null;
  destinations: { total: number; enabled: number; healthy: number; failing: number; untested: number };
  jobs30d: { total: number; succeeded: number; failed: number; partial: number; degraded: number; successRate: number };
  totalSizeBytes: number;
  retention: unknown;
  wal: { enabled: boolean; note: string };
  generatedAt: string;
}

interface ListResponse<T> {
  items: T[];
  total: number;
}

const PROVIDER_LABEL: Record<ProviderType, string> = {
  local: "本地暂存",
  s3: "S3 兼容",
  webdav: "WebDAV",
  sftp: "SFTP",
};

const PROVIDER_HINT: Record<ProviderType, string> = {
  local: "服务端磁盘目录，只作暂存，不算异地备份",
  s3: "AWS S3 或 MinIO / 阿里云 OSS 等兼容对象存储",
  webdav: "Nextcloud / ownCloud 等，生产只允许 https",
  sftp: "自有服务器，需固定 SSH 主机指纹",
};

const JOB_TONE: Record<Job["status"], Tone> = {
  queued: "neutral",
  running: "info",
  partial: "warning",
  degraded: "warning",
  succeeded: "success",
  failed: "danger",
};

const JOB_LABEL: Record<Job["status"], string> = {
  queued: "排队中",
  running: "运行中",
  partial: "部分成功",
  degraded: "降级完成",
  succeeded: "成功",
  failed: "失败",
};

const TARGET_TONE: Record<JobTarget["status"], Tone> = {
  queued: "neutral",
  uploading: "info",
  uploaded: "info",
  verifying: "info",
  verified: "success",
  failed: "danger",
  skipped: "neutral",
};

const TEST_TONE: Record<Destination["lastTestStatus"], Tone> = {
  untested: "neutral",
  passed: "success",
  failed: "danger",
};

function secondsText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时`;
}

function cronText(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour] = parts;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  return cron;
}

function Metric({
  icon,
  label,
  value,
  hint,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const ring = {
    neutral: "text-muted-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-destructive",
  }[tone];
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn("shrink-0", ring)} aria-hidden>
          {icon}
        </span>
      </div>
      <div className="mt-2 text-lg font-semibold tracking-tight text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export default function BackupsPage() {
  const { hasPermission, status: sessionStatus, session } = useSession();
  const canRead = hasPermission("backup:read");
  const canWrite = hasPermission("backup:write");
  const canRestore = hasPermission("backup:restore");
  const denied = sessionStatus === "ready" && !canRead;

  const overview = useResource<Overview>(canRead ? "/api/v1/admin/backups/overview" : null);
  const destinations = useResource<ListResponse<Destination>>(canRead ? "/api/v1/admin/backups/destinations" : null);
  const policies = useResource<ListResponse<Policy>>(canRead ? "/api/v1/admin/backups/policies" : null);
  const jobs = useResource<ListResponse<Job>>(canRead ? "/api/v1/admin/backups/jobs?pageSize=20" : null);
  const restoreTests = useResource<ListResponse<RestoreTest>>(canRead ? "/api/v1/admin/backups/restore-tests?pageSize=10" : null);

  const [busy, setBusy] = useState<string | null>(null);
  const [destinationDialog, setDestinationDialog] = useState<{ open: boolean; editing: Destination | null }>({
    open: false,
    editing: null,
  });
  const [policyDialog, setPolicyDialog] = useState<{ open: boolean; editing: Policy | null }>({ open: false, editing: null });
  const [runDialog, setRunDialog] = useState(false);
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  /** 待确认删除的目标。删除会连带清掉该目标的作业副本记录，必须二次确认。 */
  const [pendingDelete, setPendingDelete] = useState<Destination | null>(null);

  const refreshAll = useCallback(() => {
    overview.refresh();
    destinations.refresh();
    policies.refresh();
    jobs.refresh();
    restoreTests.refresh();
  }, [overview, destinations, policies, jobs, restoreTests]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>, successMessage: string) => {
      setBusy(key);
      try {
        await action();
        toast.success(successMessage);
        refreshAll();
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [refreshAll],
  );

  const testDestination = (row: Destination) =>
    runAction(
      `test-${row.id}`,
      async () => {
        const result = await apiRequest<{ passed: boolean; steps: Array<{ step: string; ok: boolean; detail?: string }> }>(
          `/api/v1/admin/backups/destinations/${row.id}/test`,
          { method: "POST", body: {} },
        );
        if (!result.passed) {
          const failed = result.steps.find((step) => !step.ok);
          throw new ClientApiError(422, "TEST_FAILED", `连接测试失败：${failed?.step ?? "未知步骤"} ${failed?.detail ?? ""}`.trim());
        }
      },
      "连接测试通过",
    );

  const toggleDestination = (row: Destination, next: boolean) =>
    runAction(
      `toggle-${row.id}`,
      () => apiRequest(`/api/v1/admin/backups/destinations/${row.id}`, { method: "PATCH", body: { enabled: next } }).then(() => undefined),
      next ? "已启用该目标" : "已禁用该目标",
    );

  const confirmRemoveDestination = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    void runAction(
      `delete-${target.id}`,
      () => apiRequest(`/api/v1/admin/backups/destinations/${target.id}`, { method: "DELETE" }).then(() => undefined),
      "已删除存储目标",
    );
  };

  const togglePolicy = (row: Policy, next: boolean) =>
    runAction(
      `policy-toggle-${row.id}`,
      () => apiRequest(`/api/v1/admin/backups/policies/${row.id}`, { method: "PATCH", body: { enabled: next } }).then(() => undefined),
      next ? "已启用该策略" : "已暂停该策略",
    );

  const verifyJob = (row: Job) =>
    runAction(
      `verify-${row.id}`,
      async () => {
        const result = await apiRequest<{ ok: boolean; actual: string }>(`/api/v1/admin/backups/jobs/${row.id}/verify`, {
          method: "POST",
          body: {},
        });
        if (!result.ok) throw new ClientApiError(422, "VERIFY_MISMATCH", "完整性校验未通过：暂存文件 SHA-256 与记录不一致");
      },
      "完整性校验通过",
    );

  const restoreTest = (row: Job) =>
    runAction(
      `restore-${row.id}`,
      async () => {
        const result = await apiRequest<{ ok: boolean; rtoSeconds: number }>(`/api/v1/admin/backups/jobs/${row.id}/restore-test`, {
          method: "POST",
          body: {},
        });
        if (!result.ok) throw new ClientApiError(422, "RESTORE_FAILED", "隔离恢复演练未通过，请查看演练记录里的对账明细");
      },
      "隔离恢复演练通过",
    );

  const retryJob = (row: Job) =>
    runAction(
      `retry-${row.id}`,
      async () => {
        const result = await apiRequest<{ attempted: number; results: Array<{ status: string; error: string | null }> }>(
          `/api/v1/admin/backups/jobs/${row.id}/retry`,
          { method: "POST", body: {} },
        );
        const failedCount = result.results.filter((item) => item.status !== "verified").length;
        if (failedCount > 0) {
          const first = result.results.find((item) => item.status !== "verified");
          throw new ClientApiError(422, "RETRY_FAILED", `${failedCount} 个目标重传失败：${first?.error ?? ""}`.trim());
        }
      },
      "已重传并校验通过",
    );

  const destinationColumns: DataColumn<Destination>[] = useMemo(
    () => [
      {
        key: "name",
        header: "目标",
        cell: (row) => (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-foreground">{row.name}</span>
              {row.isRequired ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">必需</span>
                  </TooltipTrigger>
                  <TooltipContent>all_required 模式下，这个目标失败会让整次备份失败</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {PROVIDER_LABEL[row.providerType]}
              {row.credentialConfigured ? " · 凭证已配置" : " · 无凭证"}
            </div>
          </div>
        ),
      },
      {
        key: "endpoint",
        header: "位置",
        className: "hidden md:table-cell",
        headerClassName: "hidden md:table-cell",
        cell: (row) => (
          <div className="max-w-[220px] min-w-0 text-xs text-muted-foreground">
            <div className="truncate" title={row.endpointUrl ?? row.rootPath ?? ""}>
              {row.endpointUrl ?? row.rootPath ?? "服务端默认目录"}
            </div>
            {row.bucket ? <div className="truncate text-[11px]">bucket: {row.bucket}</div> : null}
          </div>
        ),
      },
      {
        key: "test",
        header: "连接测试",
        width: "150px",
        cell: (row) => (
          <div className="space-y-0.5">
            <ToneBadge tone={TEST_TONE[row.lastTestStatus]}>
              {row.lastTestStatus === "passed" ? "通过" : row.lastTestStatus === "failed" ? "失败" : "未测试"}
            </ToneBadge>
            <div className="text-[11px] text-muted-foreground">{row.lastTestedAt ? formatRelative(row.lastTestedAt) : "—"}</div>
          </div>
        ),
      },
      {
        key: "enabled",
        header: "启用",
        width: "70px",
        cell: (row) => (
          <Switch
            checked={row.enabled}
            disabled={!canWrite || busy === `toggle-${row.id}`}
            onCheckedChange={(next) => toggleDestination(row, next)}
            aria-label={`${row.enabled ? "停用" : "启用"} ${row.name}`}
          />
        ),
      },
      {
        key: "actions",
        header: "操作",
        width: "132px",
        align: "right",
        cell: (row) => (
          <div className="flex items-center justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!canWrite || busy === `test-${row.id}`}
                  onClick={() => testDestination(row)}
                  aria-label={`测试 ${row.name}`}
                >
                  {busy === `test-${row.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>分阶段连接测试（认证 / 上传 / 下载比对 / 删除）</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canWrite}
              onClick={() => setDestinationDialog({ open: true, editing: row })}
              aria-label={`编辑 ${row.name}`}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canWrite || busy === `delete-${row.id}`}
              onClick={() => setPendingDelete(row)}
              aria-label={`删除 ${row.name}`}
            >
              {busy === `delete-${row.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            </Button>
          </div>
        ),
      },
    ],
    [busy, canWrite, testDestination, toggleDestination],
  );

  const policyColumns: DataColumn<Policy>[] = useMemo(
    () => [
      {
        key: "name",
        header: "策略",
        cell: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{row.name}</div>
            <div className="text-xs text-muted-foreground">
              {cronText(row.scheduleCron)} · {row.timezone}
            </div>
          </div>
        ),
      },
      {
        key: "mode",
        header: "多目标策略",
        width: "140px",
        cell: (row) => (
          <div className="space-y-0.5">
            <div className="text-xs text-foreground">
              {row.targetMode === "all_required" ? "全部必需" : row.targetMode === "primary_then_fallback" ? "主备" : "法定数"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {row.targetMode === "quorum" ? `需 ${row.requiredSuccessCount ?? 0} 个成功` : row.targetMode === "all_required" ? "全成功才算成功" : "主失败标降级"}
            </div>
          </div>
        ),
      },
      {
        key: "targets",
        header: "目标",
        className: "hidden lg:table-cell",
        headerClassName: "hidden lg:table-cell",
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.targets.map((target) => (
              <span key={target.destinationId} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {target.name}
              </span>
            ))}
          </div>
        ),
      },
      {
        key: "retention",
        header: "保留",
        width: "130px",
        className: "hidden md:table-cell",
        headerClassName: "hidden md:table-cell",
        cell: (row) => (
          <span className="text-xs text-muted-foreground">
            {row.retention
              ? `日 ${row.retention.daily ?? 0} / 周 ${row.retention.weekly ?? 0} / 月 ${row.retention.monthly ?? 0}`
              : "—"}
          </span>
        ),
      },
      {
        key: "enabled",
        header: "启用",
        width: "70px",
        cell: (row) => (
          <Switch
            checked={row.enabled}
            disabled={!canWrite || busy === `policy-toggle-${row.id}`}
            onCheckedChange={(next) => togglePolicy(row, next)}
            aria-label={`${row.enabled ? "暂停" : "启用"} ${row.name}`}
          />
        ),
      },
      {
        key: "actions",
        header: "操作",
        width: "80px",
        align: "right",
        cell: (row) => (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canWrite}
            onClick={() => setPolicyDialog({ open: true, editing: row })}
            aria-label={`编辑 ${row.name}`}
          >
            <Pencil className="size-3.5" />
          </Button>
        ),
      },
    ],
    [busy, canWrite, togglePolicy],
  );

  const jobColumns: DataColumn<Job>[] = useMemo(
    () => [
      {
        key: "backupId",
        header: "备份 ID",
        cell: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono text-xs text-foreground">{row.backupId}</div>
            <div className="text-[11px] text-muted-foreground">
              {row.policyName ?? "手工"} · {row.createdBy ?? "系统"} · {row.trigger === "manual" ? "手动" : row.trigger === "scheduled" ? "计划" : "重试"}
            </div>
          </div>
        ),
      },
      {
        key: "status",
        header: "状态",
        width: "110px",
        cell: (row) => (
          <div className="space-y-0.5">
            <ToneBadge tone={JOB_TONE[row.status]}>{JOB_LABEL[row.status]}</ToneBadge>
            {row.errorCode ? <div className="truncate text-[11px] text-destructive">{row.errorCode}</div> : null}
          </div>
        ),
      },
      {
        key: "size",
        header: "大小 / 耗时",
        width: "130px",
        className: "hidden md:table-cell",
        headerClassName: "hidden md:table-cell",
        cell: (row) => (
          <div className="text-xs text-muted-foreground">
            <div>{humanBytes(row.sizeBytes)}</div>
            <div className="text-[11px]">{row.durationMs === null ? "—" : `${Math.max(1, Math.round(row.durationMs / 1000))} 秒`}</div>
          </div>
        ),
      },
      {
        key: "targets",
        header: "目标状态",
        width: "170px",
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.targets.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : null}
            {row.targets.map((target) => (
              <Tooltip key={target.id}>
                <TooltipTrigger asChild>
                  <span>
                    <ToneBadge tone={TARGET_TONE[target.status]} dot={false}>
                      {target.destinationName}
                    </ToneBadge>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {PROVIDER_LABEL[target.providerType]} · {target.status}
                  {target.errorMessage ? ` · ${target.errorMessage}` : ""}
                  {target.retryCount > 0 ? ` · 已重试 ${target.retryCount} 次` : ""}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ),
      },
      {
        key: "finishedAt",
        header: "完成时间",
        width: "120px",
        className: "hidden lg:table-cell",
        headerClassName: "hidden lg:table-cell",
        cell: (row) => <span className="text-xs text-muted-foreground">{row.finishedAt ? formatDateTime(row.finishedAt) : "—"}</span>,
      },
      {
        key: "actions",
        header: "操作",
        width: "132px",
        align: "right",
        cell: (row) => {
          const hasFailedTarget = row.targets.some((target) => target.status === "failed");
          return (
            <div className="flex items-center justify-end gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!canWrite || !row.hasLocalStaging || busy === `verify-${row.id}`}
                    onClick={() => verifyJob(row)}
                    aria-label="完整性校验"
                  >
                    {busy === `verify-${row.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重算暂存文件 SHA-256，确认备份包没坏</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!canRestore || !row.hasLocalStaging || busy === `restore-${row.id}`}
                    onClick={() => restoreTest(row)}
                    aria-label="隔离恢复演练"
                  >
                    {busy === `restore-${row.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>恢复到临时库并对账，绝不碰生产库</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!canWrite || !hasFailedTarget || busy === `retry-${row.id}`}
                    onClick={() => retryJob(row)}
                    aria-label="重传失败副本"
                  >
                    {busy === `retry-${row.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRightLeft className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>重传失败目标；远端内容已一致时不会重复上传</TooltipContent>
              </Tooltip>
              <Button variant="ghost" size="icon-sm" onClick={() => setDetailJob(row)} aria-label="查看详情">
                <ShieldQuestion className="size-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    [busy, canRestore, canWrite, verifyJob, restoreTest, retryJob],
  );

  const restoreColumns: DataColumn<RestoreTest>[] = useMemo(
    () => [
      {
        key: "createdAt",
        header: "演练时间",
        cell: (row) => (
          <div className="min-w-0">
            <div className="text-xs text-foreground">{formatDateTime(row.createdAt)}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{row.backupId ?? "—"}</div>
          </div>
        ),
      },
      {
        key: "status",
        header: "结果",
        width: "96px",
        cell: (row) => (
          <ToneBadge tone={row.status === "passed" ? "success" : row.status === "failed" ? "danger" : "info"}>
            {row.status === "passed" ? "通过" : row.status === "failed" ? "失败" : "进行中"}
          </ToneBadge>
        ),
      },
      {
        key: "env",
        header: "演练环境",
        className: "hidden md:table-cell",
        headerClassName: "hidden md:table-cell",
        cell: (row) => <span className="font-mono text-[11px] text-muted-foreground">{row.testEnvironment}</span>,
      },
      {
        key: "rto",
        header: "实测 RTO",
        width: "96px",
        cell: (row) => <span className="text-xs text-foreground">{secondsText(row.rtoSeconds)}</span>,
      },
      {
        key: "checks",
        header: "对账项",
        className: "hidden lg:table-cell",
        headerClassName: "hidden lg:table-cell",
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.checks.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : null}
            {row.checks.map((check) => (
              <Tooltip key={check.name}>
                <TooltipTrigger asChild>
                  <span>
                    <ToneBadge tone={check.ok ? "success" : "danger"} dot={false}>
                      {check.name}
                    </ToneBadge>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{check.detail}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ),
      },
    ],
    [],
  );

  const overviewData = overview.data;
  const rpoTargetSeconds = overviewData?.targets.rpoSeconds ?? 86400;
  const rtoTargetSeconds = overviewData?.targets.rtoSeconds ?? 1800;
  const rpoMeasured = overviewData?.measured.rpoSeconds ?? null;
  const rtoMeasured = overviewData?.measured.rtoSeconds ?? null;

  if (denied) {
    return (
      <div className="space-y-4">
        <PageHeader title="备份与灾备" description="需要 backup:read 权限。" />
        <EmptyState title="没有查看备份的权限" description="请让组织所有者或管理员为你分配「备份与灾备」相关角色。" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="备份与灾备"
        description="多目标备份、完整性校验与隔离恢复演练。所有数字来自真实作业记录，不做估算。"
        breadcrumbs={[
          { label: "系统管理", href: "/app/settings/members" },
          { label: "备份与灾备" },
        ]}
        meta={
          <>
            <ToneBadge tone={overviewData?.lastSuccess ? "success" : "warning"}>
              {overviewData?.lastSuccess ? "有可用备份" : "尚无成功备份"}
            </ToneBadge>
            <span className="text-xs text-muted-foreground">
              统计时间 {overviewData ? formatDateTime(overviewData.generatedAt) : "—"}
              {session?.organization.timezone ? ` · 时区 ${session.organization.timezone}` : ""}
            </span>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshAll}
              disabled={overview.isRefreshing || jobs.isRefreshing}
            >
              <RefreshCw className={cn("size-4", (overview.isRefreshing || jobs.isRefreshing) && "animate-spin")} />
              刷新
            </Button>
            <Button size="sm" disabled={!canWrite} onClick={() => setRunDialog(true)}>
              <PlayCircle className="size-4" />
              立即备份
            </Button>
          </>
        }
      />

      {!canWrite ? (
        <Alert>
          <Lock className="size-4" />
          <AlertTitle>当前账号对备份只有只读权限</AlertTitle>
          <AlertDescription>
            可以查看存储目标、备份策略、作业历史与恢复演练结果，但按钮是禁用的。
            需要发起备份、修改目标或做恢复演练，请联系管理员为你的角色开通
            <span className="font-medium text-foreground"> backup:write </span>
            与
            <span className="font-medium text-foreground"> backup:restore</span>。
          </AlertDescription>
        </Alert>
      ) : null}

      <Alert>
        <AlertTriangle className="size-4" />
        <AlertTitle>生产库恢复不在本页提供</AlertTitle>
        <AlertDescription>
          规格要求生产恢复必须由 Owner 执行、二次确认并输入确认短语、写入不可删除审计。当前版本只提供
          <span className="font-medium text-foreground">隔离恢复演练</span>
          （恢复到临时库 → 对账 → 删库），这是唯一能在不碰生产数据的前提下验证备份可用性的方式。
          真正的生产回滚属于 P1，届时会带 dry-run 与双人确认。
        </AlertDescription>
      </Alert>

      <Section title="概览" description="RPO / RTO 的目标与实测、最近一次成功与失败、目标健康度。">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            icon={<DatabaseBackup className="size-4" />}
            label="最近成功备份"
            tone={overviewData?.lastSuccess ? "success" : "danger"}
            value={overviewData?.lastSuccess ? humanBytes(overviewData.lastSuccess.sizeBytes) : "—"}
            hint={
              overviewData?.lastSuccess
                ? `${formatRelative(overviewData.lastSuccess.finishedAt)} · ${overviewData.lastSuccess.backupId}`
                : "还没有一次成功备份"
            }
          />
          <Metric
            icon={<ShieldCheck className="size-4" />}
            label="最近完整性校验"
            tone={overviewData?.lastVerifiedAt ? "success" : "warning"}
            value={overviewData?.lastVerifiedAt ? formatRelative(overviewData.lastVerifiedAt) : "未校验"}
            hint="下载回读比对 SHA-256，远端声明的校验值不算数"
          />
          <Metric
            icon={<RotateCcw className="size-4" />}
            label="最近恢复演练"
            tone={overviewData?.lastRestoreTest?.status === "passed" ? "success" : overviewData?.lastRestoreTest ? "danger" : "warning"}
            value={
              overviewData?.lastRestoreTest
                ? overviewData.lastRestoreTest.status === "passed"
                  ? "通过"
                  : "失败"
                : "未演练"
            }
            hint={overviewData?.lastRestoreTest?.finishedAt ? formatRelative(overviewData.lastRestoreTest.finishedAt) : "建议上线前先跑一次"}
          />
          <Metric
            icon={<HardDrive className="size-4" />}
            label="30 天成功率"
            tone={
              (overviewData?.jobs30d.successRate ?? 0) >= 0.99
                ? "success"
                : (overviewData?.jobs30d.successRate ?? 0) >= 0.9
                  ? "warning"
                  : "danger"
            }
            value={formatPercent(overviewData?.jobs30d.successRate)}
            hint={`${overviewData?.jobs30d.succeeded ?? 0} / ${overviewData?.jobs30d.total ?? 0} 次 · 降级 ${overviewData?.jobs30d.degraded ?? 0} · 失败 ${overviewData?.jobs30d.failed ?? 0}`}
          />
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[1.1fr_1fr]">
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-xs font-medium text-muted-foreground">RPO / RTO</div>
            <div className="mt-2 grid grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] text-muted-foreground">RPO 目标</div>
                <div className="text-sm font-medium text-foreground">{secondsText(rpoTargetSeconds)}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  实测 {rpoMeasured === null ? "—" : secondsText(rpoMeasured)}
                  {rpoMeasured !== null && rpoMeasured > rpoTargetSeconds ? " · 已超出目标" : ""}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">RTO 目标</div>
                <div className="text-sm font-medium text-foreground">{secondsText(rtoTargetSeconds)}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  实测 {rtoMeasured === null ? "未演练" : secondsText(rtoMeasured)}
                  {rtoMeasured !== null && rtoMeasured > rtoTargetSeconds ? " · 已超出目标" : ""}
                </div>
              </div>
            </div>
            <div className="mt-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
              RPO 实测 = 距最近一次成功备份的时长；RTO 实测 = 最近一次通过的隔离恢复演练耗时。
            </div>
          </div>
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-xs font-medium text-muted-foreground">目标健康</div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span>
                共 <span className="font-medium text-foreground">{overviewData?.destinations.total ?? 0}</span> 个
              </span>
              <span>
                启用 <span className="font-medium text-foreground">{overviewData?.destinations.enabled ?? 0}</span>
              </span>
              <span>
                健康 <span className="font-medium text-emerald-600 dark:text-emerald-400">{overviewData?.destinations.healthy ?? 0}</span>
              </span>
              <span>
                失败 <span className="font-medium text-destructive">{overviewData?.destinations.failing ?? 0}</span>
              </span>
              <span>
                未测 <span className="font-medium text-foreground">{overviewData?.destinations.untested ?? 0}</span>
              </span>
            </div>
            <div className="mt-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
              WAL 归档：
              <span className={overviewData?.wal.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {overviewData?.wal.enabled ? "已启用" : "未启用"}
              </span>
              <div className="mt-1 leading-relaxed">{overviewData?.wal.note}</div>
            </div>
            {overviewData?.lastFailure ? (
              <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
                最近失败：{overviewData.lastFailure.backupId} · {overviewData.lastFailure.errorMessage ?? overviewData.lastFailure.errorCode}
              </div>
            ) : null}
          </div>
        </div>
      </Section>

      <Section
        title="存储目标"
        description="P0 支持本地暂存、S3 兼容、WebDAV（https）、SFTP 四种协议。未实测的连接器不会出现在这里。"
        actions={
          <Button variant="outline" size="sm" disabled={!canWrite} onClick={() => setDestinationDialog({ open: true, editing: null })}>
            <Plus className="size-4" />
            新增目标
          </Button>
        }
      >
        <DataTable
          columns={destinationColumns}
          rows={destinations.data?.items ?? null}
          rowKey={(row) => row.id}
          loading={destinations.isLoading}
          error={destinations.error}
          onRetry={destinations.refresh}
          empty={<EmptyState title="还没有存储目标" description="至少配置一个目标才能执行备份；异地备份建议再配一个云端目标。" />}
        />
      </Section>

      <Section
        title="备份策略"
        description="调度、目标组合、成功判定方式与保留策略。多目标策略决定了「什么时候算成功」。"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={!canWrite || (destinations.data?.items.length ?? 0) === 0}
            onClick={() => setPolicyDialog({ open: true, editing: null })}
          >
            <Plus className="size-4" />
            新增策略
          </Button>
        }
      >
        <DataTable
          columns={policyColumns}
          rows={policies.data?.items ?? null}
          rowKey={(row) => row.id}
          loading={policies.isLoading}
          error={policies.error}
          onRetry={policies.refresh}
          empty={
            <EmptyState
              title="还没有备份策略"
              description={
                (destinations.data?.items.length ?? 0) === 0 ? "先添加存储目标，再创建策略。" : "没有策略也可以手动备份，但不会有定时执行。"
              }
            />
          }
        />
      </Section>

      <Section
        title="作业历史"
        description="每次备份的目标级状态、大小与耗时。校验与演练只对还有本地暂存的作业可用。"
        actions={
          <Link
            href="/app/security/audit-logs?resource=backup_job"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            查看备份审计
          </Link>
        }
      >
        <DataTable
          columns={jobColumns}
          rows={jobs.data?.items ?? null}
          rowKey={(row) => row.id}
          loading={jobs.isLoading}
          error={jobs.error}
          onRetry={jobs.refresh}
          empty={<EmptyState title="还没有备份作业" description="点右上角「立即备份」跑一次，或等策略到点自动执行。" />}
        />
      </Section>

      <Section title="恢复演练" description="每次隔离恢复的环境、对账项与实测 RTO。这是备份可用性的唯一证据。">
        <DataTable
          columns={restoreColumns}
          rows={restoreTests.data?.items ?? null}
          rowKey={(row) => row.id}
          loading={restoreTests.isLoading}
          error={restoreTests.error}
          onRetry={restoreTests.refresh}
          empty={<EmptyState title="还没有演练记录" description="在作业历史里点「隔离恢复演练」，几分钟内就能得到结论。" />}
        />
      </Section>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => (next ? undefined : setPendingDelete(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除存储目标「{pendingDelete?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后该目标无法再接收备份；它历史上的作业副本记录也会一并清除（作业本体与审计保留）。
              只想暂停使用时，请改用「启用」开关停用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveDestination}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DestinationDialog
        open={destinationDialog.open}
        editing={destinationDialog.editing}
        onClose={() => setDestinationDialog({ open: false, editing: null })}
        onSaved={() => {
          setDestinationDialog({ open: false, editing: null });
          refreshAll();
        }}
      />

      <PolicyDialog
        open={policyDialog.open}
        editing={policyDialog.editing}
        destinations={destinations.data?.items ?? []}
        onClose={() => setPolicyDialog({ open: false, editing: null })}
        onSaved={() => {
          setPolicyDialog({ open: false, editing: null });
          refreshAll();
        }}
      />

      <RunDialog
        open={runDialog}
        policies={policies.data?.items ?? []}
        onClose={() => setRunDialog(false)}
        onDone={() => {
          setRunDialog(false);
          refreshAll();
        }}
      />

      <Dialog open={detailJob !== null} onOpenChange={(next) => (next ? undefined : setDetailJob(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>作业详情</DialogTitle>
            <DialogDescription className="font-mono text-xs">{detailJob?.backupId}</DialogDescription>
          </DialogHeader>
          {detailJob ? (
            <div className="space-y-3">
              <InfoGrid
                columns={3}
                items={[
                  { label: "状态", value: JOB_LABEL[detailJob.status] },
                  { label: "大小", value: humanBytes(detailJob.sizeBytes) },
                  { label: "耗时", value: detailJob.durationMs === null ? "—" : `${Math.max(1, Math.round(detailJob.durationMs / 1000))} 秒` },
                  { label: "开始", value: detailJob.startedAt ? formatDateTime(detailJob.startedAt) : "—" },
                  { label: "完成", value: detailJob.finishedAt ? formatDateTime(detailJob.finishedAt) : "—" },
                  { label: "触发者", value: detailJob.createdBy ?? "系统" },
                  { label: "本地暂存", value: detailJob.hasLocalStaging ? "存在" : "已清理" },
                  { label: "清单 SHA-256", value: <span className="break-all font-mono text-[11px]">{detailJob.manifestSha256 ?? "—"}</span> },
                  { label: "策略", value: detailJob.policyName ?? "手工备份" },
                ]}
              />
              <div className="space-y-2">
                {detailJob.targets.map((target) => (
                  <div key={target.id} className="rounded-lg border border-border/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">{target.destinationName}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{target.remoteUri ?? "—"}</div>
                      </div>
                      <ToneBadge tone={TARGET_TONE[target.status]}>{target.status}</ToneBadge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground sm:grid-cols-4">
                      <span>大小 {humanBytes(target.remoteSizeBytes)}</span>
                      <span>重试次数 {target.retryCount}</span>
                      <span>上传 {target.uploadedAt ? formatRelative(target.uploadedAt) : "—"}</span>
                      <span>校验 {target.verifiedAt ? formatRelative(target.verifiedAt) : "—"}</span>
                    </div>
                    {target.errorMessage ? (
                      <div className="mt-1 text-[11px] text-destructive">
                        {target.errorCode}: {target.errorMessage}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailJob(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 目标表单：按协议动态显示字段，凭证只在填写时才提交。 */
function DestinationDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Destination | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState<ProviderType>("local");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [remotePrefix, setRemotePrefix] = useState("");
  const [isRequired, setIsRequired] = useState(true);
  const [tlsVerify, setTlsVerify] = useState(true);
  const [credentialKind, setCredentialKind] = useState<CredentialKind>("access_key");
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [hostKey, setHostKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时用当前行回填；新建时清空。用 key 控制挂载比在 effect 里同步更可靠。
  const dialogKey = `${open}-${editing?.id ?? "new"}`;

  return (
    <Dialog
      key={dialogKey}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
        else {
          setName(editing?.name ?? "");
          setProviderType(editing?.providerType ?? "local");
          setEndpointUrl(editing?.endpointUrl ?? "");
          setRegion(editing?.region ?? "");
          setBucket(editing?.bucket ?? "");
          setRootPath(editing?.rootPath ?? "");
          setRemotePrefix(editing?.remotePrefix ?? "");
          setIsRequired(editing?.isRequired ?? true);
          setTlsVerify(editing?.tlsVerify ?? true);
          setCredentialKind(editing?.providerType === "webdav" ? "username_password" : editing?.providerType === "sftp" ? "ssh_key" : "access_key");
          setIdentifier("");
          setSecret("");
          setHostKey("");
          setError(null);
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑存储目标" : "新增存储目标"}</DialogTitle>
          <DialogDescription>{PROVIDER_HINT[providerType]}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="名称" htmlFor="destination-name" required>
            <Input
              id="destination-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：上海机房本地盘 / 阿里云 OSS"
              maxLength={120}
            />
          </FormField>

          <FormField label="协议" required>
            <Select
              value={providerType}
              onValueChange={(value) => {
                const next = value as ProviderType;
                setProviderType(next);
                setCredentialKind(next === "s3" ? "access_key" : next === "webdav" ? "username_password" : next === "sftp" ? "ssh_key" : "access_key");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PROVIDER_LABEL) as ProviderType[]).map((item) => (
                  <SelectItem key={item} value={item}>
                    {PROVIDER_LABEL[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {providerType !== "local" ? (
            <>
              <FormField label={providerType === "sftp" ? "主机地址" : "Endpoint"} required>
                <Input
                  value={endpointUrl}
                  onChange={(event) => setEndpointUrl(event.target.value)}
                  placeholder={providerType === "s3" ? "https://s3.us-east-1.amazonaws.com" : providerType === "webdav" ? "https://cloud.example.com/remote.php/dav/files/u" : "backup.example.com:22"}
                />
              </FormField>
              {providerType === "s3" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Region">
                    <Input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="us-east-1" />
                  </FormField>
                  <FormField label="Bucket" required>
                    <Input value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder="licensing-backups" />
                  </FormField>
                </div>
              ) : null}
            </>
          ) : (
            <FormField label="本地目录" htmlFor="destination-root" hint="留空则使用服务端默认暂存目录；建议填一个独立挂载点">
              <Input id="destination-root" value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder=".backups" />
            </FormField>
          )}

          <FormField label="远端前缀" htmlFor="destination-prefix" hint="每个备份会写到 <前缀>/<backup_id>.zmbk，backup_id 唯一，不会互相覆盖">
            <Input id="destination-prefix" value={remotePrefix} onChange={(event) => setRemotePrefix(event.target.value)} placeholder="backups/production" />
          </FormField>

          {providerType !== "local" ? (
            <div className="rounded-lg border border-border/70 p-3">
              <div className="mb-2 text-xs font-medium text-foreground">
                {editing?.credentialConfigured ? "轮换凭证（留空则保持不变）" : "凭证（只在这里输入一次，后端加密存储）"}
              </div>
              <div className="space-y-2">
                <FormField label={credentialKind === "access_key" ? "Access Key ID" : credentialKind === "username_password" ? "用户名" : "SSH 用户名"}>
                  <Input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="off" />
                </FormField>
                <FormField
                  label={credentialKind === "access_key" ? "Secret Access Key" : credentialKind === "username_password" ? "密码" : "私钥（PEM）"}
                >
                  {credentialKind === "ssh_key" ? (
                    <textarea
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    />
                  ) : (
                    <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" />
                  )}
                </FormField>
                {credentialKind === "ssh_key" ? (
                  <FormField label="主机指纹（known_hosts 行）" hint="必填：不固定指纹就无法防止中间人，此处的指纹会逐次比对">
                    <Input value={hostKey} onChange={(event) => setHostKey(event.target.value)} placeholder="ssh-ed25519 AAAAC3Nza..." />
                  </FormField>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-foreground">必需目标</div>
              <div className="text-[11px] text-muted-foreground">all_required 模式下，它失败会让整次备份记为失败</div>
            </div>
            <Switch checked={isRequired} onCheckedChange={setIsRequired} aria-label="必需目标" />
          </div>

          {providerType === "webdav" || providerType === "s3" ? (
            <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
              <div>
                <div className="text-xs font-medium text-foreground">校验 TLS 证书</div>
                <div className="text-[11px] text-muted-foreground">生产环境请保持开启；关闭仅用于自签名证书的内网联调</div>
              </div>
              <Switch checked={tlsVerify} onCheckedChange={setTlsVerify} aria-label="校验 TLS 证书" />
            </div>
          ) : null}

          <FormError message={error} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            disabled={submitting}
            onClick={async () => {
              setError(null);
              if (!name.trim()) {
                setError("请填写名称");
                return;
              }
              const credential =
                providerType === "local" || (!identifier.trim() && !secret.trim())
                  ? undefined
                  : credentialKind === "access_key"
                    ? { kind: "access_key" as const, accessKeyId: identifier, secretAccessKey: secret }
                    : credentialKind === "username_password"
                      ? { kind: "username_password" as const, username: identifier, password: secret }
                      : { kind: "ssh_key" as const, username: identifier, privateKey: secret, hostKey: hostKey || undefined };

              const body = {
                name: name.trim(),
                providerType,
                authMethod: providerType === "local" ? "none" : credentialKind,
                endpointUrl: providerType === "local" ? null : endpointUrl || null,
                region: region || null,
                bucket: bucket || null,
                rootPath: rootPath || null,
                remotePrefix: remotePrefix || null,
                isRequired,
                tlsVerify,
                ...(credential ? { credential } : {}),
              };

              setSubmitting(true);
              try {
                if (editing) {
                  await apiRequest(`/api/v1/admin/backups/destinations/${editing.id}`, { method: "PATCH", body });
                  toast.success("已更新存储目标");
                } else {
                  await apiRequest("/api/v1/admin/backups/destinations", { method: "POST", body });
                  toast.success("已创建存储目标");
                }
                onSaved();
              } catch (cause) {
                setError(errorMessage(cause));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {editing ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 策略表单：调度、多目标模式、保留策略、目标选择。 */
function PolicyDialog({
  open,
  editing,
  destinations,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Policy | null;
  destinations: Destination[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [scheduleCron, setScheduleCron] = useState(editing?.scheduleCron ?? "0 3 * * *");
  const [targetMode, setTargetMode] = useState<TargetMode>(editing?.targetMode ?? "all_required");
  const [requiredSuccessCount, setRequiredSuccessCount] = useState(String(editing?.requiredSuccessCount ?? 1));
  const [daily, setDaily] = useState(String(editing?.retention?.daily ?? 7));
  const [weekly, setWeekly] = useState(String(editing?.retention?.weekly ?? 4));
  const [monthly, setMonthly] = useState(String(editing?.retention?.monthly ?? 6));
  const [selected, setSelected] = useState<Set<string>>(
    new Set(editing?.targets.map((target) => target.destinationId) ?? destinations.slice(0, 1).map((item) => item.id)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑备份策略" : "新增备份策略"}</DialogTitle>
          <DialogDescription>调度到点会自动执行；也可以随时用「立即备份」手动触发同一条策略。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="策略名称" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每日全量 · 本地 + 异地" maxLength={120} />
          </FormField>

          <FormField label="调度（cron）" hint="5 段 cron，例如 0 3 * * * 表示每天 03:00">
            <Input value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} placeholder="0 3 * * *" />
          </FormField>

          <FormField label="多目标成功判定" required>
            <Select value={targetMode} onValueChange={(value) => setTargetMode(value as TargetMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_required">全部必需目标都成功（默认）</SelectItem>
                <SelectItem value="primary_then_fallback">主目标优先，备用成功标降级</SelectItem>
                <SelectItem value="quorum">达到法定成功数即可</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          {targetMode === "quorum" ? (
            <FormField label="需要几个目标成功" required>
              <Input
                type="number"
                min={1}
                max={Math.max(1, selected.size)}
                value={requiredSuccessCount}
                onChange={(event) => setRequiredSuccessCount(event.target.value)}
              />
            </FormField>
          ) : null}

          <FormField label="备份目标" required hint="只有启用中的目标可以加入策略">
            <div className="space-y-1.5">
              {destinations.length === 0 ? <div className="text-xs text-muted-foreground">还没有存储目标</div> : null}
              {destinations.map((item) => (
                <label
                  key={item.id}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-2 text-xs",
                    item.enabled ? "hover:bg-muted/40" : "cursor-not-allowed opacity-50",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={selected.has(item.id)}
                      disabled={!item.enabled}
                      onChange={() => toggle(item.id)}
                    />
                    <span className="truncate">{item.name}</span>
                    <span className="text-[11px] text-muted-foreground">{PROVIDER_LABEL[item.providerType]}</span>
                  </span>
                  {item.isRequired ? <span className="text-[10px] text-muted-foreground">必需</span> : null}
                </label>
              ))}
            </div>
          </FormField>

          <div className="grid grid-cols-3 gap-2">
            <FormField label="保留 日">
              <Input type="number" min={1} max={365} value={daily} onChange={(event) => setDaily(event.target.value)} />
            </FormField>
            <FormField label="保留 周">
              <Input type="number" min={0} max={104} value={weekly} onChange={(event) => setWeekly(event.target.value)} />
            </FormField>
            <FormField label="保留 月">
              <Input type="number" min={0} max={120} value={monthly} onChange={(event) => setMonthly(event.target.value)} />
            </FormField>
          </div>

          <FormError message={error} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            disabled={submitting}
            onClick={async () => {
              setError(null);
              if (!name.trim()) return setError("请填写策略名称");
              if (selected.size === 0) return setError("至少选择一个备份目标");
              setSubmitting(true);
              try {
                const body = {
                  name: name.trim(),
                  scheduleCron,
                  targetMode,
                  requiredSuccessCount: targetMode === "quorum" ? Number(requiredSuccessCount) : null,
                  retention: { daily: Number(daily), weekly: Number(weekly), monthly: Number(monthly) },
                  targets: Array.from(selected).map((destinationId, index) => ({ destinationId, priority: (index + 1) * 10 })),
                };
                if (editing) {
                  await apiRequest(`/api/v1/admin/backups/policies/${editing.id}`, { method: "PATCH", body });
                  toast.success("已更新备份策略");
                } else {
                  await apiRequest("/api/v1/admin/backups/policies", { method: "POST", body });
                  toast.success("已创建备份策略");
                }
                onSaved();
              } catch (cause) {
                setError(errorMessage(cause));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {editing ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 立即备份：可以按策略跑，也可以只跑某个目标（用于单点验证）。 */
function RunDialog({
  open,
  policies,
  onClose,
  onDone,
}: {
  open: boolean;
  policies: Policy[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [policyId, setPolicyId] = useState<string>("all");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>立即备份</DialogTitle>
          <DialogDescription>同步执行一次 pg_dump → 加密 → 上传 → 下载回读校验，几秒内返回结果。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="使用策略">
            <Select value={policyId} onValueChange={setPolicyId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">不使用策略（跑所有启用目标）</SelectItem>
                {policies.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormHint>备份包会加密后写到每个目标的独立 backup_id 路径，不会覆盖历史备份。</FormHint>
          <FormError message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            disabled={submitting}
            onClick={async () => {
              setError(null);
              setSubmitting(true);
              try {
                const result = await apiRequest<{ status: string; sizeBytes: number; backupId: string }>("/api/v1/admin/backups/jobs", {
                  method: "POST",
                  body: { policyId: policyId === "all" ? null : policyId },
                });
                if (result.status === "failed") throw new ClientApiError(422, "BACKUP_FAILED", "备份失败，请查看作业详情");
                toast.success(`备份完成：${result.backupId}（${humanBytes(result.sizeBytes)}）`);
                onDone();
              } catch (cause) {
                setError(errorMessage(cause));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
            开始备份
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
