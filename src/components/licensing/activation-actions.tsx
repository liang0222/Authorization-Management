"use client";

import { useState } from "react";
import { Ban, MoreHorizontal, Unplug, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { apiRequest, errorMessage } from "@/lib/client/api";
import { useSession } from "@/lib/client/session-context";

type Mode = null | "release" | "block" | "unblock";

/** 设备操作：解绑（释放名额）与禁用/恢复分开（规格 15.8）。 */
export function ActivationActions({
  activation,
  onChanged,
  compact = false,
}: {
  activation: { id: string; status: string; deviceName: string | null };
  onChanged: () => void;
  compact?: boolean;
}) {
  const { hasPermission } = useSession();
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState("");

  const close = () => {
    setMode(null);
    setReason("");
  };

  const run = async (action: "release" | "block" | "unblock") => {
    try {
      await apiRequest(`/api/v1/admin/activations/${activation.id}/${action}`, {
        method: "POST",
        body: { reason: reason.trim() || "管理员操作" },
      });
      toast.success(action === "release" ? "设备已解绑，名额已释放" : action === "block" ? "设备已禁用" : "设备已恢复");
      onChanged();
    } catch (cause) {
      throw new Error(errorMessage(cause));
    }
  };

  if (!hasPermission("activation:release") && !hasPermission("activation:block")) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon-sm" : "sm"} aria-label="设备操作">
            {compact ? <MoreHorizontal className="size-4" /> : <><MoreHorizontal className="size-3.5" /> 操作</>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {activation.status === "active" && hasPermission("activation:release") ? (
            <DropdownMenuItem onSelect={() => setMode("release")}>
              <Unplug className="size-3.5" /> 解绑设备
            </DropdownMenuItem>
          ) : null}
          {activation.status === "active" && hasPermission("activation:block") ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setMode("block")}>
              <Ban className="size-3.5" /> 禁用设备
            </DropdownMenuItem>
          ) : null}
          {activation.status === "blocked" && hasPermission("activation:block") ? (
            <DropdownMenuItem onSelect={() => setMode("unblock")}>
              <Undo2 className="size-3.5" /> 恢复设备
            </DropdownMenuItem>
          ) : null}
          {activation.status !== "active" && activation.status !== "blocked" ? (
            <DropdownMenuItem disabled>该激活记录已终态</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={mode !== null}
        onOpenChange={(open) => (open ? null : close())}
        title={
          mode === "release" ? "解绑设备" : mode === "block" ? "禁用设备" : "恢复设备"
        }
        description={
          mode === "release"
            ? `将解绑设备「${activation.deviceName ?? activation.id.slice(0, 8)}」。解绑会释放一个设备名额；默认不返还累计激活次数。`
            : mode === "block"
              ? `将禁用设备「${activation.deviceName ?? ""}」。设备无法再通过校验，可随时恢复。`
              : "恢复后该设备可以继续使用当前授权（仍要求授权本身有效）。"
        }
        confirmLabel={mode === "release" ? "确认解绑" : mode === "block" ? "确认禁用" : "确认恢复"}
        tone={mode === "block" ? "danger" : "default"}
        onConfirm={async () => {
          if (mode) await run(mode);
        }}
      >
        <Label htmlFor="activation-reason" className="text-xs">
          操作原因 <span className="text-muted-foreground">（写入审计日志）</span>
        </Label>
        <Textarea
          id="activation-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          placeholder="例如：客户更换电脑，核对身份后释放旧设备"
        />
      </ConfirmDialog>
    </>
  );
}
