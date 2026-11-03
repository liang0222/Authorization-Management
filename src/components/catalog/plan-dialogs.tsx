"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import type { Lookups } from "@/lib/types";

export const DURATION_PRESETS = [
  { key: "7d", label: "7 天", unit: "day", value: 7 },
  { key: "15d", label: "15 天", unit: "day", value: 15 },
  { key: "30d", label: "30 天", unit: "day", value: 30 },
  { key: "1q", label: "一季度（3 个自然月）", unit: "month", value: 3 },
  { key: "1y", label: "一年（12 个自然月）", unit: "month", value: 12 },
  { key: "lifetime", label: "永久授权", unit: "lifetime", value: 0 },
] as const;

export const START_POLICY_LABEL: Record<string, string> = {
  on_first_activation: "首次激活起算",
  fixed_start: "固定时间起算",
};

type Unit = "day" | "month" | "lifetime";

interface PlanFormState {
  productId: string;
  code: string;
  name: string;
  description: string;
  unit: Unit;
  value: number;
  startPolicy: string;
  activationDeadlineDays: string;
  maxDevices: number;
  maxActivationCount: string;
  maxSubjects: string;
  refundActivationOnRelease: boolean;
  offlineAllowed: boolean;
  offlineGraceSeconds: number;
  features: Record<string, unknown>;
  status: string;
}

const DEFAULTS: PlanFormState = {
  productId: "",
  code: "",
  name: "",
  description: "",
  unit: "day",
  value: 30,
  startPolicy: "on_first_activation",
  activationDeadlineDays: "30",
  maxDevices: 1,
  maxActivationCount: "",
  maxSubjects: "",
  refundActivationOnRelease: false,
  offlineAllowed: true,
  offlineGraceSeconds: 604800,
  features: {},
  status: "active",
};

export interface PlanFormInitial {
  id?: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  unit: Unit;
  value: number;
  startPolicy: string;
  activationDeadlineDays: number | null;
  maxDevices: number;
  maxActivationCount: number | null;
  maxSubjects: number | null;
  refundActivationOnRelease: boolean;
  offlineAllowed: boolean;
  offlineGraceSeconds: number;
  featureOverrides?: Record<string, unknown>;
}

function featureInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function coerceFeatureValue(raw: string, valueType: string): unknown {
  const text = raw.trim();
  if (valueType === "boolean") return text === "true";
  if (valueType === "number") return Number(text || "0");
  if (valueType === "json") {
    try {
      return JSON.parse(text || "null");
    } catch {
      throw new Error("功能默认值不是合法 JSON");
    }
  }
  return text;
}

/** 套餐表单：新建与编辑共用。标准周期的单位与数值是独立的两层，不是自由文本。 */
export function PlanFormDialog({
  open,
  onOpenChange,
  lookups,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lookups: Lookups | undefined;
  initial?: PlanFormInitial | null;
  onSaved: () => void;
}) {
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState<PlanFormState>(DEFAULTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        productId: initial.productId,
        code: initial.code,
        name: initial.name,
        description: initial.description ?? "",
        unit: initial.unit,
        value: initial.value,
        startPolicy: initial.startPolicy,
        activationDeadlineDays: initial.activationDeadlineDays === null ? "" : String(initial.activationDeadlineDays),
        maxDevices: initial.maxDevices,
        maxActivationCount: initial.maxActivationCount === null ? "" : String(initial.maxActivationCount),
        maxSubjects: initial.maxSubjects === null ? "" : String(initial.maxSubjects),
        refundActivationOnRelease: initial.refundActivationOnRelease,
        offlineAllowed: initial.offlineAllowed,
        offlineGraceSeconds: initial.offlineGraceSeconds,
        features: initial.featureOverrides ?? {},
        status: initial.status,
      });
    } else {
      setForm({ ...DEFAULTS, productId: lookups?.products[0]?.id ?? "" });
    }
    setError(null);
    setFieldErrors({});
  }, [open, initial, lookups]);

  const patch = (next: Partial<PlanFormState>) => setForm((prev) => ({ ...prev, ...next }));

  const productFeatures = useMemo(
    () => (lookups?.features ?? []).filter((feature) => feature.productId === form.productId),
    [lookups, form.productId],
  );

  const presetKey = DURATION_PRESETS.find((preset) => preset.unit === form.unit && preset.value === form.value)?.key;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const features = productFeatures
        .filter((feature) => featureInputValue(form.features[feature.code]) !== "")
        .map((feature) => ({
          code: feature.code,
          value: coerceFeatureValue(featureInputValue(form.features[feature.code]), feature.valueType),
        }));

      const body = {
        productId: form.productId,
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        duration: { unit: form.unit, value: form.unit === "lifetime" ? 0 : form.value },
        startPolicy: form.startPolicy,
        activationDeadlineDays: form.activationDeadlineDays === "" ? null : Number(form.activationDeadlineDays),
        maxDevices: form.maxDevices,
        maxActivationCount: form.maxActivationCount === "" ? null : Number(form.maxActivationCount),
        maxSubjects: form.maxSubjects === "" ? null : Number(form.maxSubjects),
        refundActivationOnRelease: form.refundActivationOnRelease,
        offlineAllowed: form.offlineAllowed,
        offlineGraceSeconds: form.offlineGraceSeconds,
        features,
        ...(isEdit ? { status: form.status } : {}),
      };

      if (isEdit) {
        await apiRequest(`/api/v1/admin/plans/${initial!.id}`, { method: "PATCH", body });
        toast.success("套餐已保存", { description: "已签发授权保留原有期限快照，不受影响。" });
      } else {
        await apiRequest("/api/v1/admin/plans", { method: "POST", body });
        toast.success("套餐已创建", { description: "签发授权时可以直接套用这个套餐。" });
      }
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑套餐" : "新建套餐"}</DialogTitle>
          <DialogDescription>
            套餐把标准周期、设备上限与功能默认值打包。修改套餐不会回填已签发的授权。
          </DialogDescription>
        </DialogHeader>

        <form id="plan-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="所属产品" required error={fieldErrors.productId} hint={isEdit ? "套餐创建后不可更换产品。" : undefined}>
              <Select
                value={form.productId}
                onValueChange={(value) => patch({ productId: value, features: {} })}
                disabled={isEdit}
              >
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
            <FormField label="套餐编码" htmlFor="plan-code" required error={fieldErrors.code} hint="小写字母、数字、- 与 _">
              <Input
                id="plan-code"
                value={form.code}
                onChange={(event) => patch({ code: event.target.value })}
                placeholder="pro-year"
                className="font-mono text-xs"
                disabled={isEdit}
                required
              />
            </FormField>
          </div>

          <FormField label="套餐名称" htmlFor="plan-name" required error={fieldErrors.name}>
            <Input id="plan-name" value={form.name} onChange={(event) => patch({ name: event.target.value })} placeholder="专业版（年付）" required />
          </FormField>

          <FormField label="说明" htmlFor="plan-description">
            <Textarea
              id="plan-description"
              value={form.description}
              onChange={(event) => patch({ description: event.target.value })}
              rows={2}
            />
          </FormField>

          <FormField label="标准周期" required error={fieldErrors.duration} hint="自然月按授权时区计算，月末自动钳制（1 月 31 日 + 1 个月 → 2 月 28/29 日）。">
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((preset) => (
                <Button
                  key={preset.key}
                  type="button"
                  size="sm"
                  variant={presetKey === preset.key ? "default" : "outline"}
                  onClick={() => patch({ unit: preset.unit as Unit, value: preset.value })}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </FormField>

          {presetKey ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="周期单位" required>
                <Select value={form.unit} onValueChange={(value) => patch({ unit: value as Unit })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">天</SelectItem>
                    <SelectItem value="month">自然月</SelectItem>
                    <SelectItem value="lifetime">永久</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="周期数值" htmlFor="plan-duration-value" required>
                <Input
                  id="plan-duration-value"
                  type="number"
                  min={form.unit === "month" ? 1 : 1}
                  max={form.unit === "month" ? 120 : 3650}
                  value={form.unit === "lifetime" ? 0 : form.value}
                  onChange={(event) => patch({ value: Number(event.target.value) })}
                  disabled={form.unit === "lifetime"}
                  className="tabular"
                />
              </FormField>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="起算方式" required error={fieldErrors.startPolicy}>
              <Select value={form.startPolicy} onValueChange={(value) => patch({ startPolicy: value })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="on_first_activation">首次激活起算</SelectItem>
                  <SelectItem value="fixed_start">固定时间起算</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label="激活截止（天）"
              htmlFor="plan-activation-deadline"
              error={fieldErrors.activationDeadlineDays}
              hint="留空表示不限制；超过截止日激活返回 410。"
            >
              <Input
                id="plan-activation-deadline"
                type="number"
                min={1}
                max={3650}
                value={form.activationDeadlineDays}
                onChange={(event) => patch({ activationDeadlineDays: event.target.value })}
                className="tabular"
              />
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="设备上限" htmlFor="plan-max-devices" required error={fieldErrors.maxDevices}>
              <Input
                id="plan-max-devices"
                type="number"
                min={1}
                max={999}
                value={form.maxDevices}
                onChange={(event) => patch({ maxDevices: Number(event.target.value) })}
                className="tabular"
              />
            </FormField>
            <FormField label="激活次数上限" htmlFor="plan-max-activations" error={fieldErrors.maxActivationCount} hint="留空不限">
              <Input
                id="plan-max-activations"
                type="number"
                min={1}
                value={form.maxActivationCount}
                onChange={(event) => patch({ maxActivationCount: event.target.value })}
                className="tabular"
              />
            </FormField>
            <FormField label="席位上限" htmlFor="plan-max-subjects" error={fieldErrors.maxSubjects} hint="留空不限">
              <Input
                id="plan-max-subjects"
                type="number"
                min={1}
                value={form.maxSubjects}
                onChange={(event) => patch({ maxSubjects: event.target.value })}
                className="tabular"
              />
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">解绑返还激活次数</p>
                <p className="text-[11px] text-muted-foreground">默认不返还，防止反复换机。</p>
              </div>
              <Switch
                checked={form.refundActivationOnRelease}
                onCheckedChange={(checked) => patch({ refundActivationOnRelease: checked })}
                aria-label="解绑是否返还激活次数"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">允许离线授权</p>
                <p className="text-[11px] text-muted-foreground">签名文件可在离线宽限期内使用。</p>
              </div>
              <Switch
                checked={form.offlineAllowed}
                onCheckedChange={(checked) => patch({ offlineAllowed: checked })}
                aria-label="是否允许离线授权"
              />
            </div>
          </div>

          {form.offlineAllowed ? (
            <FormField
              label="离线宽限期（秒）"
              htmlFor="plan-offline-grace"
              error={fieldErrors.offlineGraceSeconds}
              hint="默认 604800 秒（7 天）。"
            >
              <Input
                id="plan-offline-grace"
                type="number"
                min={0}
                max={31536000}
                value={form.offlineGraceSeconds}
                onChange={(event) => patch({ offlineGraceSeconds: Number(event.target.value) })}
                className="tabular"
              />
            </FormField>
          ) : null}

          <FormField
            label="功能默认值"
            hint={
              productFeatures.length === 0
                ? "该产品还没有定义功能权限，保存后可在产品详情里补充。"
                : "留空表示不覆盖，使用功能定义里的默认值。"
            }
          >
            <div className="space-y-2 rounded-md border border-border px-3 py-2">
              {productFeatures.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无可配置功能</p>
              ) : (
                productFeatures.map((feature) => (
                  <div key={feature.id} className="flex items-center justify-between gap-3">
                    <label htmlFor={`feature-${feature.code}`} className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground">{feature.name}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {feature.code} · {feature.valueType}
                      </span>
                    </label>
                    {feature.valueType === "boolean" ? (
                      <Switch
                        id={`feature-${feature.code}`}
                        checked={String(form.features[feature.code] ?? feature.defaultValue) === "true"}
                        onCheckedChange={(checked) =>
                          patch({ features: { ...form.features, [feature.code]: checked } })
                        }
                        aria-label={`${feature.name} 默认值`}
                      />
                    ) : (
                      <Input
                        id={`feature-${feature.code}`}
                        value={featureInputValue(form.features[feature.code])}
                        onChange={(event) =>
                          patch({ features: { ...form.features, [feature.code]: event.target.value } })
                        }
                        placeholder={featureInputValue(feature.defaultValue)}
                        className="h-8 w-40 font-mono text-xs"
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          </FormField>

          {isEdit ? (
            <FormField label="套餐状态" hint="停用后不能再被签发流程选择，已签发授权不受影响。">
              <Select value={form.status} onValueChange={(value) => patch({ status: value })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">启用</SelectItem>
                  <SelectItem value="disabled">停用</SelectItem>
                  <SelectItem value="archived">归档</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          ) : null}

          <FormHint>
            修改套餐只影响后续签发；已签发授权保存的是签发时的期限与上限快照。
          </FormHint>
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="plan-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {isEdit ? "保存套餐" : "创建套餐"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
