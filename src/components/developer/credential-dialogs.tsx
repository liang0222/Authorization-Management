"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { SecretReveal } from "@/components/app/secret-reveal";
import { ToneBadge } from "@/components/app/status-badge";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import type { Lookups } from "@/lib/types";

export const CREDENTIAL_SCOPES = [
  { value: "license:validate", label: "license:validate", hint: "校验授权码状态" },
  { value: "activation:create", label: "activation:create", hint: "首次激活 / 绑定设备" },
  { value: "activation:heartbeat", label: "activation:heartbeat", hint: "心跳续期令牌" },
  { value: "activation:deactivate", label: "activation:deactivate", hint: "解绑设备" },
  { value: "entitlements:read", label: "entitlements:read", hint: "读取功能权限" },
  { value: "offline:grant", label: "offline:grant", hint: "签发离线许可" },
  { value: "server:check", label: "server:check", hint: "服务端并发校验" },
  { value: "server:assign", label: "server:assign", hint: "服务端席位分配" },
];

export const CREDENTIAL_TYPE_LABEL: Record<string, string> = {
  public_client: "公开客户端",
  confidential_server: "机密服务端",
};

export const CREDENTIAL_STATUS_LABEL: Record<string, string> = {
  active: "生效中",
  disabled: "已停用",
  archived: "已归档",
};

export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  clientId: string;
  status: string;
  hasSecret: boolean;
  scopes: string[];
  allowedOrigins: string[];
  productId: string;
  product: { id: string; name: string; code: string };
  expiresAt: string | null;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
}

const DEFAULT_SCOPES = ["license:validate", "activation:create", "activation:heartbeat", "entitlements:read"];

/** 新建凭证：机密服务端凭证会一次性返回 clientSecret，公开客户端只有 clientId。 */
export function CreateCredentialDialog({
  open,
  onOpenChange,
  lookups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lookups: Lookups | undefined;
  onCreated: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("public_client");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [origins, setOrigins] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ clientId: string; clientSecret?: string; secretNotice?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setProductId(lookups?.products[0]?.id ?? "");
    setName("");
    setType("public_client");
    setScopes(DEFAULT_SCOPES);
    setOrigins("");
    setError(null);
    setFieldErrors({});
    setResult(null);
  }, [open, lookups]);

  const toggleScope = (value: string) => {
    setScopes((prev) => (prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const allowedOrigins =
        type === "public_client"
          ? []
          : origins
              .split(/[\s,]+/)
              .map((item) => item.trim())
              .filter(Boolean);
      const data = await apiRequest<{ clientId: string; clientSecret?: string; secretNotice?: string }>(
        "/api/v1/admin/credentials",
        {
          method: "POST",
          body: { name: name.trim(), productId, type, scopes, allowedOrigins },
        },
      );
      setResult(data);
      onCreated();
      toast.success("API 凭证已创建", { description: `${name} 现在可以调用对应产品的客户端接口。` });
    } catch (err) {
      if (err instanceof ClientApiError) setFieldErrors(err.fieldErrors);
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{result ? "凭证已创建" : "新建 API 凭证"}</DialogTitle>
          <DialogDescription>
            {result
              ? "密钥只在这里显示一次，请立即复制到客户端配置中。"
              : "公开客户端用于桌面端 / 扩展 / 小程序，机密服务端用于自有后端。服务端只保存密钥哈希。"}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <SecretReveal
              title="凭证信息"
              description={result.secretNotice ?? "请把下面两项写入客户端配置。"}
              secrets={[
                { label: "client_id（可公开）", value: result.clientId, hint: "随请求头发送 x-client-id" },
                ...(result.clientSecret
                  ? [{ label: "client_secret（仅显示一次）", value: result.clientSecret, hint: "服务端换取令牌时使用" }]
                  : []),
              ]}
              warning={
                result.clientSecret
                  ? "关闭后无法再次查看明文。如需更换，请对这条凭证执行「轮换密钥」。"
                  : "公开客户端没有密钥，安全性依赖客户端签名（Ed25519 设备密钥）。"
              }
            />
            <DialogFooter>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                完成
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form id="credential-form" className="space-y-3" onSubmit={submit}>
            <FormError message={error} />

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="所属产品" required error={fieldErrors.productId}>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择产品" />
                  </SelectTrigger>
                  <SelectContent>
                    {(lookups?.products ?? []).map((product) => (
                      <SelectItem key={product.id} value={product.id}>
                        {product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="凭证名称" htmlFor="credential-name" required error={fieldErrors.name}>
                <Input
                  id="credential-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="桌面端正式环境"
                  required
                />
              </FormField>
            </div>

            <FormField label="凭证类型" required error={fieldErrors.type}>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public_client">公开客户端（无密钥，设备签名鉴权）</SelectItem>
                  <SelectItem value="confidential_server">机密服务端（client_secret 鉴权）</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="授权范围" required error={fieldErrors.scopes}>
              <div className="grid gap-1.5 rounded-lg border border-border p-2.5 sm:grid-cols-2">
                {CREDENTIAL_SCOPES.map((scope) => (
                  <label
                    key={scope.value}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
                  >
                    <Checkbox
                      checked={scopes.includes(scope.value)}
                      onCheckedChange={() => toggleScope(scope.value)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-[11px] text-foreground">{scope.label}</span>
                      <span className="block text-[10px] text-muted-foreground">{scope.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </FormField>

            {type === "confidential_server" ? (
              <FormField
                label="允许来源"
                htmlFor="credential-origins"
                error={fieldErrors.allowedOrigins}
                hint="可选，逗号或换行分隔；留空表示不限制来源。"
              >
                <Input
                  id="credential-origins"
                  value={origins}
                  onChange={(event) => setOrigins(event.target.value)}
                  placeholder="https://app.example.com"
                  className="font-mono text-xs"
                />
              </FormField>
            ) : (
              <FormHint>公开客户端不能配置允许来源，接口会直接拒绝这类请求。</FormHint>
            )}
          </form>
        )}

        {result ? null : (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" form="credential-form" size="sm" disabled={submitting}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              创建凭证
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 轮换密钥：仅机密服务端凭证可用，成功后一次性展示新的 client_secret。 */
export function RotateCredentialDialog({
  credential,
  onOpenChange,
  onRotated,
}: {
  credential: CredentialRow | null;
  onOpenChange: (open: boolean) => void;
  onRotated: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ clientId: string; clientSecret: string; rotatedAt: string } | null>(null);

  useEffect(() => {
    if (!credential) {
      setResult(null);
      setError(null);
    }
  }, [credential]);

  const submit = async () => {
    if (!credential) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiRequest<{ clientId: string; clientSecret: string; rotatedAt: string }>(
        `/api/v1/admin/credentials/${credential.id}`,
        { method: "PATCH", body: { action: "rotate" } },
      );
      setResult(data);
      onRotated();
      toast.success("密钥已轮换", { description: "旧密钥立即失效，请同步更新客户端配置。" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(credential)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{result ? "密钥已轮换" : "轮换 client_secret"}</DialogTitle>
          <DialogDescription>
            {result
              ? "新密钥只显示一次。旧密钥已失效，尚未更新的客户端会立即鉴权失败。"
              : "轮换会立刻作废旧密钥。请确认你可以在同一时间更新所有调用方。"}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <SecretReveal
            title="新的凭证信息"
            description="把下面的密钥写入服务端配置后重启服务。"
            secrets={[
              { label: "client_id", value: result.clientId },
              { label: "client_secret（仅显示一次）", value: result.clientSecret },
            ]}
            warning="关闭后无法再次查看明文；若丢失需要再次轮换。"
          />
        ) : (
          <div className="space-y-3">
            <FormError message={error} />
            {credential ? (
              <div className="rounded-lg border border-border p-3 text-xs">
                <p className="font-medium text-foreground">{credential.name}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{credential.clientId}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <ToneBadge tone="neutral" dot={false}>
                    {CREDENTIAL_TYPE_LABEL[credential.type] ?? credential.type}
                  </ToneBadge>
                  <ToneBadge tone="neutral" dot={false}>
                    {credential.product.name}
                  </ToneBadge>
                  {credential.rotatedAt ? (
                    <ToneBadge tone="warning" dot={false}>
                      上次轮换 {credential.rotatedAt.slice(0, 10)}
                    </ToneBadge>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              我已保存
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
                取消
              </Button>
              <Button size="sm" onClick={submit} disabled={submitting}>
                {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                确认轮换
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 编辑凭证：名称、授权范围、允许来源（类型与 client_id 不可改）。 */
export function EditCredentialDialog({
  credential,
  onOpenChange,
  onSaved,
}: {
  credential: CredentialRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [origins, setOrigins] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!credential) return;
    setName(credential.name);
    setScopes(credential.scopes);
    setOrigins(credential.allowedOrigins.join("\n"));
    setError(null);
    setFieldErrors({});
  }, [credential]);

  const toggleScope = (value: string) => {
    setScopes((prev) => (prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!credential) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiRequest(`/api/v1/admin/credentials/${credential.id}`, {
        method: "PATCH",
        body: {
          action: "update",
          name: name.trim(),
          scopes,
          allowedOrigins:
            credential.type === "public_client"
              ? []
              : origins
                  .split(/[\s,]+/)
                  .map((item) => item.trim())
                  .filter(Boolean),
        },
      });
      toast.success("凭证已更新", { description: "新的授权范围立即生效。" });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ClientApiError) setFieldErrors(err.fieldErrors);
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(credential)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>编辑 API 凭证</DialogTitle>
          <DialogDescription>client_id 与凭证类型创建后不可修改；缩小授权范围会立即影响调用方。</DialogDescription>
        </DialogHeader>

        <form id="credential-edit-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />
          <FormField label="凭证名称" htmlFor="credential-edit-name" required error={fieldErrors.name}>
            <Input
              id="credential-edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </FormField>

          <FormField label="client_id" hint="不可修改">
            <Input value={credential?.clientId ?? ""} readOnly className="font-mono text-xs" />
          </FormField>

          <FormField label="授权范围" required error={fieldErrors.scopes}>
            <div className="grid gap-1.5 rounded-lg border border-border p-2.5 sm:grid-cols-2">
              {CREDENTIAL_SCOPES.map((scope) => (
                <label
                  key={scope.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
                >
                  <Checkbox
                    checked={scopes.includes(scope.value)}
                    onCheckedChange={() => toggleScope(scope.value)}
                    className="mt-0.5"
                  />
                  <span className="font-mono text-[11px] text-foreground">{scope.label}</span>
                </label>
              ))}
            </div>
          </FormField>

          {credential?.type === "confidential_server" ? (
            <FormField label="允许来源" htmlFor="credential-edit-origins" error={fieldErrors.allowedOrigins}>
              <Input
                id="credential-edit-origins"
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
                placeholder="https://app.example.com"
                className="font-mono text-xs"
              />
            </FormField>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="credential-edit-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
