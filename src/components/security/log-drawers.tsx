"use client";

import Link from "next/link";
import { ExternalLink, ShieldCheck } from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/app/copy-button";
import { HttpStatusBadge, ToneBadge } from "@/components/app/status-badge";
import { JsonBlock } from "@/components/security/json-block";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface VerificationLogRow {
  id: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  errorCode: string | null;
  latencyMs: number;
  ip: string | null;
  productId: string | null;
  productName: string | null;
  createdAt: string;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs break-all text-foreground">{children}</dd>
    </div>
  );
}

/** 验证日志详情抽屉：完整字段只读展示，日志本身没有任何编辑入口。 */
export function VerificationLogDrawer({
  row,
  onOpenChange,
  timeZone,
}: {
  row: VerificationLogRow | null;
  onOpenChange: (open: boolean) => void;
  timeZone?: string;
}) {
  return (
    <Drawer open={Boolean(row)} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="w-full sm:max-w-[560px]">
        <DrawerHeader className="border-b border-border">
          <DrawerTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{row?.method ?? "—"}</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row?.route ?? ""}</span>
            {row ? <HttpStatusBadge status={row.status} /> : null}
          </DrawerTitle>
          <DrawerDescription>单条验证请求的完整记录（只读）。</DrawerDescription>
        </DrawerHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {row ? (
            <>
              <dl className="rounded-lg border border-border px-3 py-1">
                <MetaRow label="时间">{formatDateTime(row.createdAt, timeZone)}</MetaRow>
                <MetaRow label="HTTP 状态">
                  <HttpStatusBadge status={row.status} />
                </MetaRow>
                <MetaRow label="错误码">
                  {row.errorCode ? (
                    <span className="font-mono text-[11px]">{row.errorCode}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </MetaRow>
                <MetaRow label="延迟">
                  <span className={cn("tabular", row.latencyMs > 200 && "text-warning")}>{row.latencyMs} ms</span>
                </MetaRow>
                <MetaRow label="IP">
                  <span className="font-mono text-[11px]">{row.ip ?? "—"}</span>
                </MetaRow>
                <MetaRow label="产品">{row.productName ?? "未绑定产品"}</MetaRow>
                <MetaRow label="request_id">
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono text-[11px]">{row.requestId}</span>
                    <CopyButton value={row.requestId} label="复制 request_id" tooltip="复制 request_id" />
                  </span>
                </MetaRow>
              </dl>

              <JsonBlock label="完整记录（JSON，只读）" value={row} />
            </>
          ) : null}
        </div>

        <DrawerFooter className="border-t border-border">
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            验证日志不记录授权码、Token 与私钥，只保存请求元数据与结果。
          </p>
          <DrawerClose asChild>
            <Button variant="outline">关闭</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

export interface AuditLogRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  changedFields: string[];
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** 操作审计详情抽屉：before / after 并排（窄屏自动堆叠）。 */
export function AuditLogDrawer({
  row,
  onOpenChange,
  timeZone,
}: {
  row: AuditLogRow | null;
  onOpenChange: (open: boolean) => void;
  timeZone?: string;
}) {
  return (
    <Drawer open={Boolean(row)} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="w-full sm:max-w-[720px]">
        <DrawerHeader className="border-b border-border">
          <DrawerTitle className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px]">
              {row?.action ?? "—"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {row?.resourceType ?? ""}
              {row?.resourceId ? ` · ${row.resourceId}` : ""}
            </span>
          </DrawerTitle>
          <DrawerDescription>审计记录只追加，不提供修改或删除入口。</DrawerDescription>
        </DrawerHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {row ? (
            <>
              <dl className="rounded-lg border border-border px-3 py-1">
                <MetaRow label="时间">{formatDateTime(row.createdAt, timeZone)}</MetaRow>
                <MetaRow label="操作者">
                  {row.actorName ?? (row.actorType === "system" ? "系统" : row.actorType)}
                  {row.actorEmail ? <span className="ml-1 text-muted-foreground">（{row.actorEmail}）</span> : null}
                </MetaRow>
                <MetaRow label="操作者类型">{row.actorType}</MetaRow>
                <MetaRow label="资源">
                  <span className="font-mono text-[11px]">
                    {row.resourceType} / {row.resourceId ?? "—"}
                  </span>
                  {row.resourceType === "license" && row.resourceId ? (
                    <Link
                      href={`/app/licenses/${row.resourceId}`}
                      className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline"
                    >
                      查看授权 <ExternalLink className="size-3" aria-hidden />
                    </Link>
                  ) : null}
                </MetaRow>
                <MetaRow label="变更字段">
                  {row.changedFields.length > 0 ? (
                    <span className="font-mono text-[11px]">{row.changedFields.join("、")}</span>
                  ) : (
                    <span className="text-muted-foreground">无字段级差异</span>
                  )}
                </MetaRow>
                <MetaRow label="request_id">
                  <span className="font-mono text-[11px]">{row.requestId ?? "—"}</span>
                </MetaRow>
                <MetaRow label="IP">
                  <span className="font-mono text-[11px]">{row.ip ?? "—"}</span>
                </MetaRow>
                <MetaRow label="User-Agent">
                  <span className="text-[11px]">{row.userAgent ?? "—"}</span>
                </MetaRow>
              </dl>

              <div className="grid gap-3 md:grid-cols-2">
                <JsonBlock label="变更前 before" value={row.before} emptyLabel="无 before 快照（创建类操作）" />
                <JsonBlock label="变更后 after" value={row.after} emptyLabel="无 after 快照（删除类操作）" />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ToneBadge tone="neutral" dot={false}>
                  记录 ID {row.id}
                </ToneBadge>
                <CopyButton value={row.id} label="复制审计记录 ID" tooltip="复制审计记录 ID" />
              </div>
            </>
          ) : null}
        </div>

        <DrawerFooter className="border-t border-border">
          <p className="text-xs text-muted-foreground">审计日志只追加，不提供删除入口。</p>
          <DrawerClose asChild>
            <Button variant="outline">关闭</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
