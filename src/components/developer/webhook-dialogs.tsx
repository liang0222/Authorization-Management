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
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import type { Lookups } from "@/lib/types";

export const WEBHOOK_EVENT_TYPES = [
  { value: "license.activated", label: "license.activated", hint: "授权首次激活成功" },
  { value: "license.renewed", label: "license.renewed", hint: "授权续费顺延" },
  { value: "license.suspended", label: "license.suspended", hint: "授权被暂停" },
  { value: "license.resumed", label: "license.resumed", hint: "授权恢复" },
  { value: "license.revoked", label: "license.revoked", hint: "授权被吊销" },
  { value: "license.expired", label: "license.expired", hint: "授权到期" },
  { value: "activation.created", label: "activation.created", hint: "新增设备激活" },
  { value: "activation.released", label: "activation.released", hint: "设备解绑" },
  { value: "activation.blocked", label: "activation.blocked", hint: "设备被封禁" },
  { value: "entitlements.updated", label: "entitlements.updated", hint: "功能权限变更" },
];

export const WEBHOOK_STATUS_LABEL: Record<string, string> = {
  active: "启用中",
  disabled: "已停用",
  archived: "已归档",
};

export interface WebhookRow {
  id: string;
  url: string;
  status: string;
  eventTypes: string[];
  productId: string;
  product: { id: string; name: string; code: string } | null;
  lastDelivery: { status: string; responseStatus: number | null; createdAt: string; deliveredAt: string | null } | null;
  last7d: { succeeded: number; failed: number };
  createdAt: string;
}

const DEFAULT_EVENTS = ["license.activated", "license.suspended", "license.revoked"];

function EventPicker({
  value,
  onChange,
  error,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const toggle = (event: string) =>
    onChange(value.includes(event) ? value.filter((item) => item !== event) : [...value, event]);

  return (
    <FormField label="订阅事件" required error={error}>
      <div className="grid gap-1 rounded-lg border border-border p-2.5 sm:grid-cols-2">
        {WEBHOOK_EVENT_TYPES.map((event) => (
          <label
            key={event.value}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
          >
            <Checkbox
              checked={value.includes(event.value)}
              onCheckedChange={() => toggle(event.value)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block truncate font-mono text-[11px] text-foreground">{event.label}</span>
              <span className="block text-[10px] text-muted-foreground">{event.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </FormField>
  );
}

/** 新建 Webhook：响应里一次性返回签名密钥（whsec_ 前缀），只存哈希。 */
export function CreateWebhookDialog({
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
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ url: string; secret: string; secretNotice?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setProductId(lookups?.products[0]?.id ?? "");
    setUrl("");
    setEvents(DEFAULT_EVENTS);
    setError(null);
    setFieldErrors({});
    setResult(null);
  }, [open, lookups]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const data = await apiRequest<{ url: string; secret: string; secretNotice?: string }>("/api/v1/admin/webhooks", {
        method: "POST",
        body: { productId, url: url.trim(), eventTypes: events },
      });
      setResult(data);
      onCreated();
      toast.success("Webhook 已创建", { description: "把签名密钥写入接收端用于验签。" });
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
          <DialogTitle>{result ? "Webhook 已创建" : "新建 Webhook"}</DialogTitle>
          <DialogDescription>
            {result
              ? "签名密钥只显示一次，接收端用它校验 x-signature 请求头。"
              : "授权事件发生时，服务会向这个地址 POST JSON，并带签名头。地址必须是 https 或本机回环。"}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <SecretReveal
              title="签名密钥"
              description={result.secretNotice ?? `接收地址：${result.url}`}
              secrets={[{ label: "signing secret（仅显示一次）", value: result.secret }]}
              warning="关闭后无法再次查看明文。若泄漏，请删除端点并重新创建。"
            />
            <DialogFooter>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                完成
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form id="webhook-form" className="space-y-3" onSubmit={submit}>
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
              <FormField label="投递地址" htmlFor="webhook-url" required error={fieldErrors.url}>
                <Input
                  id="webhook-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://ops.example.com/hooks/license"
                  className="font-mono text-xs"
                  required
                />
              </FormField>
            </div>

            <EventPicker value={events} onChange={setEvents} error={fieldErrors.eventTypes} />
            <FormHint>
              只有真实业务事件才触发投递，创建时不会立即发送；每次投递结果都能在端点详情里看到。
            </FormHint>
          </form>
        )}

        {result ? null : (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" form="webhook-form" size="sm" disabled={submitting}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              创建端点
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 编辑 Webhook：地址与订阅事件可改，密钥不变。 */
export function EditWebhookDialog({
  webhook,
  onOpenChange,
  onSaved,
}: {
  webhook: WebhookRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!webhook) return;
    setUrl(webhook.url);
    setEvents(webhook.eventTypes);
    setError(null);
    setFieldErrors({});
  }, [webhook]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!webhook) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiRequest(`/api/v1/admin/webhooks/${webhook.id}`, {
        method: "PATCH",
        body: { url: url.trim(), eventTypes: events },
      });
      toast.success("Webhook 已保存", { description: "新的地址与订阅立即生效。" });
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
    <Dialog open={Boolean(webhook)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>编辑 Webhook</DialogTitle>
          <DialogDescription>
            {webhook ? `${webhook.product?.name ?? "未知产品"} · 创建于 ${webhook.createdAt.slice(0, 10)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <form id="webhook-edit-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />
          <FormField label="投递地址" htmlFor="webhook-edit-url" required error={fieldErrors.url}>
            <Input
              id="webhook-edit-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="font-mono text-xs"
              required
            />
          </FormField>
          <EventPicker value={events} onChange={setEvents} error={fieldErrors.eventTypes} />
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="webhook-edit-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
