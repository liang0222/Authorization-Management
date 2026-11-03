"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Ban,
  Eye,
  KeyRound,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { CopyButton } from "@/components/app/copy-button";
import { SecretReveal } from "@/components/app/secret-reveal";
import { LicenseRenewDialog } from "@/components/licensing/license-dialogs";
import { apiRequest, errorMessage } from "@/lib/client/api";
import { useSession } from "@/lib/client/session-context";
import type { LicenseRow } from "@/lib/types";

type Mode = null | "renew" | "suspend" | "resume" | "revoke" | "rekey" | "reset-count";

/** 单份授权的行操作：每个动作都对应真实 API 与权限检查。 */
export function LicenseRowActions({
  license,
  onChanged,
}: {
  license: LicenseRow;
  onChanged: () => void;
}) {
  const { hasPermission } = useSession();
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  const terminal = license.adminStatus === "revoked" || license.adminStatus === "cancelled";
  const canRenew = hasPermission("license:renew") && !terminal;
  const canSuspend = hasPermission("license:suspend") && (license.adminStatus === "active" || license.adminStatus === "pending");
  const canResume = hasPermission("license:suspend") && license.adminStatus === "suspended";
  const canRevoke = hasPermission("license:revoke") && !terminal;
  const canRekey = hasPermission("license:rekey") && !terminal;
  const canReset = hasPermission("license:rekey") && license.activationCount > 0;

  const close = () => {
    setMode(null);
    setReason("");
  };

  const post = async (action: string, body: unknown) => {
    try {
      const result = await apiRequest<{ licenseKey?: string }>(`/api/v1/admin/licenses/${license.id}/${action}`, {
        method: "POST",
        body,
      });
      return result;
    } catch (cause) {
      throw new Error(errorMessage(cause));
    }
  };

  return (
    <>
      <div className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
        <CopyButton value={license.id} label="复制 License ID" tooltip="复制 License ID" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="更多操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {license.customer.name}
            </DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href={`/app/licenses/${license.id}`}>
                <Eye className="size-3.5" /> 查看详情
              </Link>
            </DropdownMenuItem>
            {canRenew ? (
              <DropdownMenuItem onSelect={() => setMode("renew")} disabled={license.duration.unit === "lifetime"}>
                <RefreshCcw className="size-3.5" /> 续费
              </DropdownMenuItem>
            ) : null}
            {canSuspend ? (
              <DropdownMenuItem onSelect={() => setMode("suspend")}>
                <PauseCircle className="size-3.5" /> 暂停授权
              </DropdownMenuItem>
            ) : null}
            {canResume ? (
              <DropdownMenuItem onSelect={() => setMode("resume")}>
                <PlayCircle className="size-3.5" /> 恢复授权
              </DropdownMenuItem>
            ) : null}
            {canRekey || canReset ? <DropdownMenuSeparator /> : null}
            {canRekey ? (
              <DropdownMenuItem onSelect={() => setMode("rekey")}>
                <KeyRound className="size-3.5" /> 重发兑换码
              </DropdownMenuItem>
            ) : null}
            {canReset ? (
              <DropdownMenuItem onSelect={() => setMode("reset-count")}>
                <RotateCcw className="size-3.5" /> 重置激活次数
              </DropdownMenuItem>
            ) : null}
            {canRevoke ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setMode("revoke")}>
                  <Ban className="size-3.5" /> 撤销授权
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <LicenseRenewDialog
        license={license}
        open={mode === "renew"}
        onOpenChange={(open) => (open ? setMode("renew") : close())}
        onDone={onChanged}
      />

      <ConfirmDialog
        open={mode === "suspend"}
        onOpenChange={(open) => (open ? setMode("suspend") : close())}
        title="暂停授权"
        description={`将暂停「${license.customer.name}」的 ${license.product.name} 授权。暂停后下一次在线校验立即拒绝，但不会删除设备绑定。`}
        confirmLabel="暂停授权"
        tone="default"
        onConfirm={async () => {
          await post("suspend", { reason: reason || null });
          toast.success("授权已暂停");
          onChanged();
        }}
      >
        <Label htmlFor="suspend-reason" className="text-xs">
          暂停原因（可选）
        </Label>
        <Textarea
          id="suspend-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：客户欠费，等待财务确认"
          rows={2}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={mode === "resume"}
        onOpenChange={(open) => (open ? setMode("resume") : close())}
        title="恢复授权"
        description={`恢复后，授权在有效期内可继续使用（当前管理状态：${license.adminStatus}）。`}
        confirmLabel="恢复授权"
        tone="default"
        onConfirm={async () => {
          await post("resume", {});
          toast.success("授权已恢复");
          onChanged();
        }}
      />

      <ConfirmDialog
        open={mode === "revoke"}
        onOpenChange={(open) => (open ? setMode("revoke") : close())}
        title="撤销授权（不可恢复）"
        description={`撤销「${license.customer.name}」的授权后进入终态，无法恢复；如需继续服务必须签发新授权。已绑定的 ${license.activeDevices} 台设备将在下次在线校验时被拒绝。`}
        confirmLabel="确认撤销"
        onConfirm={async () => {
          if (reason.trim().length < 2) throw new Error("请填写撤销原因（至少 2 个字）");
          await post("revoke", { reason: reason.trim() });
          toast.success("授权已撤销");
          onChanged();
        }}
      >
        <Label htmlFor="revoke-reason" className="text-xs">
          撤销原因 <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="revoke-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：客户申请退款，合同终止"
          rows={2}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={mode === "rekey"}
        onOpenChange={(open) => (open ? setMode("rekey") : close())}
        title="重发兑换码"
        description="旧兑换码会立即失效，新兑换码只显示一次。不会创建第二份授权，也不会改变设备绑定与到期时间。"
        confirmLabel="生成新兑换码"
        tone="default"
        onConfirm={async () => {
          const result = await post("rekey", {});
          if (result.licenseKey) setNewKey(result.licenseKey);
          toast.success("已生成新兑换码");
          onChanged();
        }}
      />

      <ConfirmDialog
        open={mode === "reset-count"}
        onOpenChange={(open) => (open ? setMode("reset-count") : close())}
        title="重置累计激活次数"
        description={`累计激活次数将重置为当前活跃设备数（${license.activeDevices}）。这是受控管理操作，会写入审计日志。`}
        confirmLabel="确认重置"
        onConfirm={async () => {
          if (reason.trim().length < 2) throw new Error("请填写重置原因（至少 2 个字）");
          await post("reset-activation-count", { reason: reason.trim() });
          toast.success("累计激活次数已重置");
          onChanged();
        }}
      >
        <Label htmlFor="reset-reason" className="text-xs">
          重置原因 <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="reset-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：客户更换电脑，管理员核对后释放额度"
          rows={2}
        />
      </ConfirmDialog>

      <Dialog open={Boolean(newKey)} onOpenChange={(open) => (open ? null : setNewKey(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新的兑换码</DialogTitle>
            <DialogDescription>请立即交付客户；关闭后无法再次查看明文。</DialogDescription>
          </DialogHeader>
          {newKey ? (
            <SecretReveal
              title="兑换码已更新"
              secrets={[{ label: "新兑换码", value: newKey }]}
              warning="旧兑换码已失效，客户需要重新激活。"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
