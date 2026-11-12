"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { FormError } from "@/components/app/form-field";
import { SecretReveal, licensesToCsv } from "@/components/app/secret-reveal";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { useResource } from "@/lib/client/use-resource";
import { useNow } from "@/lib/client/use-now";
import type { Lookups, LicenseRow } from "@/lib/types";
import { durationLabel } from "@/lib/format";
import { DURATION_PRESETS } from "@/lib/domain/period";

interface BatchResult {
  count: number;
  items: Array<{ id: string; licenseKey: string; expiresAt: string | null }>;
  notice: string;
}

/** 批量生成兑换码（规格 7.4）：结果只在本次显示，可在前端生成 CSV。 */
export function LicenseBatchDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: () => void;
}) {
  const lookups = useResource<Lookups>(open ? "/api/v1/admin/lookups" : null);
  const [count, setCount] = useState("10");
  const [productId, setProductId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [planId, setPlanId] = useState("none");
  const [durationId, setDurationId] = useState("30d");
  const [maxDevices, setMaxDevices] = useState("1");
  const [maxActivationCount, setMaxActivationCount] = useState("3");
  const [activationDeadline, setActivationDeadline] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);

  const plans = (lookups.data?.plans ?? []).filter((plan) => plan.productId === productId);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const duration =
        DURATION_PRESETS.find((item) => item.id === durationId)?.duration ?? { unit: "day", value: 30 };
      const payload = {
        count: Number(count) || 1,
        productId,
        customerId,
        planId: planId === "none" ? null : planId,
        duration,
        startPolicy: "on_first_activation",
        activationDeadlineAt: activationDeadline ? new Date(activationDeadline).toISOString() : null,
        maxDevices: Number(maxDevices) || 1,
        maxActivationCount: maxActivationCount ? Number(maxActivationCount) : null,
        notes: notes || null,
      };
      const batch = await apiRequest<BatchResult>("/api/v1/admin/licenses/batch", {
        method: "POST",
        body: payload,
      });
      setResult(batch);
      toast.success(`已生成 ${batch.count} 张授权`);
      onIssued?.();
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ClientApiError && Object.keys(cause.fieldErrors).length > 0) {
        setError(Object.values(cause.fieldErrors).join("；"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        if (!next) {
          setResult(null);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量生成兑换码</DialogTitle>
          <DialogDescription>
            单次最多 50 张；结果只返回一次，请立即下载或复制。更大批量需使用异步任务（后续版本）。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <SecretReveal
              title={`已生成 ${result.count} 张授权`}
              description="每张授权拥有独立 License ID 与兑换码"
              secrets={result.items.map((item) => ({ label: `兑换码 · ${item.id.slice(0, 8)}`, value: item.licenseKey }))}
              download={{ filename: `licenses-${result.items[0]?.id.slice(0, 8) ?? "export"}.csv`, content: licensesToCsv(result.items) }}
              warning={result.notice}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setResult(null)}>
                继续生成
              </Button>
              <Button onClick={() => onOpenChange(false)}>完成</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="batch-count">数量</Label>
                <Input
                  id="batch-count"
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="batch-duration">周期</Label>
                <Select value={durationId} onValueChange={setDurationId}>
                  <SelectTrigger id="batch-duration" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="batch-product">产品</Label>
              <Select value={productId} onValueChange={(value) => { setProductId(value); setPlanId("none"); }}>
                <SelectTrigger id="batch-product" className="w-full">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {lookups.data?.products
                    .filter((product) => product.status === "active")
                    .map((product) => (
                      <SelectItem key={product.id} value={product.id}>
                        {product.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="batch-customer">客户</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger id="batch-customer" className="w-full">
                  <SelectValue placeholder="选择客户" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {lookups.data?.customers.map((customer) => (
                    <SelectItem key={customer.id} value={customer.id}>
                      {customer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="batch-plan">套餐（可选）</Label>
              <Select value={planId} onValueChange={setPlanId} disabled={!productId}>
                <SelectTrigger id="batch-plan" className="w-full">
                  <SelectValue placeholder="不基于套餐" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不基于套餐</SelectItem>
                  {plans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name} · {durationLabel(plan.duration)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="batch-devices">每张最大设备数</Label>
                <Input
                  id="batch-devices"
                  type="number"
                  min={1}
                  value={maxDevices}
                  onChange={(event) => setMaxDevices(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="batch-activations">累计激活次数</Label>
                <Input
                  id="batch-activations"
                  type="number"
                  min={1}
                  value={maxActivationCount}
                  onChange={(event) => setMaxActivationCount(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="batch-deadline">首次激活截止（可选）</Label>
              <Input
                id="batch-deadline"
                type="datetime-local"
                value={activationDeadline}
                onChange={(event) => setActivationDeadline(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="batch-notes">备注（可选）</Label>
              <Input id="batch-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>

            <FormError message={error} />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                取消
              </Button>
              <Button type="submit" disabled={submitting || !productId || !customerId || Number(count) <= 0}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {submitting ? "正在生成…" : `生成 ${count || 0} 张授权`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 续费对话框：默认从原到期时间追加，已过期则从服务器当前时间起算。 */
export function LicenseRenewDialog({
  license,
  open,
  onOpenChange,
  onDone,
}: {
  license: LicenseRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [durationId, setDurationId] = useState("1y");
  const [fromNow, setFromNow] = useState(false);
  const [paymentRef, setPaymentRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const submit = async () => {
    if (!license) return;
    setSubmitting(true);
    setError(null);
    try {
      const duration =
        DURATION_PRESETS.find((item) => item.id === durationId)?.duration ?? { unit: "month", value: 12 };
      const result = await apiRequest<{ newExpiresAt: string | null; mode: string }>(
        `/api/v1/admin/licenses/${license.id}/renew`,
        { method: "POST", body: { duration, fromNow, paymentRef: paymentRef || null } },
      );
      toast.success(
        result.mode === "from_now" ? "已续费，新周期从当前时间起算" : "已续费，到期时间已顺延",
      );
      onDone();
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const lifetime = license?.duration.unit === "lifetime";

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? null : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>续费授权</DialogTitle>
          <DialogDescription>
            当前到期：{license?.expiresAt ? new Date(license.expiresAt).toLocaleString("zh-CN") : "—"}
            {license && new Date(license.expiresAt ?? 0).getTime() < now
              ? "（已过期，默认从当前时间重新起算）"
              : "（未到期，从原到期时间顺延）"}
          </DialogDescription>
        </DialogHeader>
        {lifetime ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            永久授权不接受普通期限续费。如需延长或变更，请走套餐变更流程。
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>续费周期</Label>
              <div className="flex flex-wrap gap-1.5">
                {DURATION_PRESETS.filter((preset) => preset.duration.unit !== "lifetime").map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    size="xs"
                    variant={durationId === preset.id ? "default" : "outline"}
                    onClick={() => setDurationId(preset.id)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={fromNow} onCheckedChange={(value) => setFromNow(Boolean(value))} />
              从当前时间重新起算（用于补续费，会记审计）
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="payment-ref">支付/订单引用（可选）</Label>
              <Input
                id="payment-ref"
                value={paymentRef}
                onChange={(event) => setPaymentRef(event.target.value)}
                placeholder="PAY-2026-0001"
              />
            </div>
            <FormError message={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || lifetime}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {submitting ? "正在续费…" : "确认续费"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
