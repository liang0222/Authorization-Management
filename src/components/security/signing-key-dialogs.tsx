"use client";

import { useState } from "react";
import { Ban, CheckCircle2, MoreHorizontal, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { CopyButton } from "@/components/app/copy-button";
import { useResource } from "@/lib/client/use-resource";
import { apiRequest, errorMessage } from "@/lib/client/api";
import type { Lookups } from "@/lib/types";

/** Ed25519 签名密钥状态机（staged → active → retiring → revoked，revoked 为终态）。 */
export type SigningKeyStatus = "staged" | "active" | "retiring" | "revoked";
export type SigningKeyAction = "activate" | "retire" | "revoke";

export interface SigningKeyRow {
  id: string;
  kid: string;
  algorithm: string;
  status: SigningKeyStatus;
  productId: string | null;
  product: { id: string; name: string; code: string } | null;
  notBefore: string;
  notAfter: string | null;
  publicKeyFingerprint: string;
  privateKeyRef: string;
  createdAt: string;
}

/**
 * 生成签名密钥（POST /admin/signing-keys）。
 * 私钥只在服务端落盘（0600），接口不返回私钥，页面也就不存在可展示的私钥字段。
 */
export function CreateSigningKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const lookups = useResource<Lookups>(open ? "/api/v1/admin/lookups" : null);
  const [productId, setProductId] = useState("none");
  const [notAfter, setNotAfter] = useState("");

  const submit = async () => {
    if (notAfter) {
      const value = new Date(notAfter);
      if (Number.isNaN(value.getTime())) throw new Error("到期时间格式不正确");
      if (value.getTime() <= Date.now()) throw new Error("到期时间必须晚于当前时间");
    }
    try {
      await apiRequest("/api/v1/admin/signing-keys", {
        method: "POST",
        body: {
          productId: productId === "none" ? null : productId,
          notAfter: notAfter ? new Date(notAfter).toISOString() : null,
        },
      });
      toast.success("签名密钥已生成，私钥只写入服务器密钥目录");
      setProductId("none");
      setNotAfter("");
      onCreated();
    } catch (cause) {
      throw new Error(errorMessage(cause));
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="生成签名密钥"
      description="服务端现场生成一对 Ed25519 密钥：私钥只会写入服务器受限目录（权限 0600），页面不会也不能显示私钥；数据库只保存公钥与私钥文件名。"
      confirmLabel="生成密钥"
      tone="default"
      onConfirm={submit}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="signing-key-product" className="text-xs">
            关联产品（可选）
          </Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger id="signing-key-product" size="sm" className="w-full">
              <SelectValue placeholder="不绑定产品" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不绑定产品（组织通用密钥）</SelectItem>
              {(lookups.data?.products ?? []).map((product) => (
                <SelectItem key={product.id} value={product.id}>
                  {product.name} · {product.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">绑定后该密钥仅用于此产品的离线授权签发。</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="signing-key-not-after" className="text-xs">
            密钥到期时间（可选）
          </Label>
          <Input
            id="signing-key-not-after"
            type="datetime-local"
            value={notAfter}
            onChange={(event) => setNotAfter(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">留空表示长期有效；到期后不再用它签发新文件。</p>
        </div>
      </div>
    </ConfirmDialog>
  );
}

/** 单把密钥的行操作：启用 / 进入轮换 / 吊销（都是不可逆或需二次确认的动作）。 */
export function SigningKeyRowActions({
  id,
  kid,
  status,
  onChanged,
}: {
  id: string;
  kid: string;
  status: SigningKeyStatus;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<SigningKeyAction | null>(null);

  const terminal = status === "revoked";
  const canActivate = status === "staged";
  const canRetire = status === "active";

  const apply = async (action: SigningKeyAction) => {
    try {
      await apiRequest(`/api/v1/admin/signing-keys/${id}`, { method: "PATCH", body: { action } });
    } catch (cause) {
      throw new Error(errorMessage(cause));
    }
  };

  const close = () => setMode(null);

  return (
    <>
      <div className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
        <CopyButton value={kid} label="复制 kid" tooltip="复制密钥标识（kid）" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`密钥 ${kid} 的更多操作`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="truncate font-mono text-[11px] font-normal text-muted-foreground">
              {kid}
            </DropdownMenuLabel>
            {terminal ? (
              <DropdownMenuItem disabled>已吊销（终态，不可变更）</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem disabled={!canActivate} onSelect={() => setMode("activate")}>
                  <CheckCircle2 className="size-3.5" /> 启用（staged → active）
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canRetire} onSelect={() => setMode("retire")}>
                  <RotateCcw className="size-3.5" /> 进入轮换（active → retiring）
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setMode("revoke")}>
                  <Ban className="size-3.5" /> 吊销密钥
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ConfirmDialog
        open={mode === "activate"}
        onOpenChange={(open) => (open ? setMode("activate") : close())}
        title="启用签名密钥"
        description={`把「${kid}」从 staged 置为 active。启用后新签发的离线授权会使用这把密钥，客户端需要同步它的公钥。`}
        confirmLabel="启用密钥"
        tone="default"
        onConfirm={async () => {
          await apply("activate");
          toast.success("密钥已启用");
          onChanged();
        }}
      />

      <ConfirmDialog
        open={mode === "retire"}
        onOpenChange={(open) => (open ? setMode("retire") : close())}
        title="进入轮换"
        description={`「${kid}」进入 retiring 后不再签发新文件；已签发的离线授权在有效期内仍可用这把公钥验证，便于新旧密钥平滑切换。`}
        confirmLabel="进入轮换"
        tone="default"
        onConfirm={async () => {
          await apply("retire");
          toast.success("密钥已进入轮换状态");
          onChanged();
        }}
      />

      <ConfirmDialog
        open={mode === "revoke"}
        onOpenChange={(open) => (open ? setMode("revoke") : close())}
        title="吊销签名密钥（不可恢复）"
        description={`吊销「${kid}」后进入终态，无法再启用。已签发的离线授权在有效期内仍可验证旧公钥，但系统不再签发新文件；需要继续签发必须生成新密钥。`}
        confirmLabel="确认吊销"
        onConfirm={async () => {
          await apply("revoke");
          toast.success("密钥已吊销");
          onChanged();
        }}
      />
    </>
  );
}
