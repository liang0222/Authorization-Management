"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { SecretReveal } from "@/components/app/secret-reveal";
import { apiRequest, ClientApiError } from "@/lib/client/api";
import { useResource } from "@/lib/client/use-resource";
import { DURATION_PRESETS } from "@/lib/domain/period";
import { formatDateTime } from "@/lib/format";

interface Lookups {
  products: Array<{ id: string; code: string; name: string; type: string; status: string }>;
  customers: Array<{ id: string; name: string; email: string | null; customer_code: string | null }>;
  plans: Array<{
    id: string;
    code: string;
    name: string;
    productId: string;
    duration: { unit: "day" | "month" | "lifetime"; value: number };
    maxDevices: number;
    maxActivationCount: number | null;
    maxSubjects: number | null;
    startPolicy: string;
    activationDeadlineDays: number | null;
    offlineAllowed: boolean;
    offlineGraceSeconds: number;
    refundActivationOnRelease: boolean;
    defaultFeatures: Record<string, unknown>;
  }>;
  features: Array<{
    id: string;
    productId: string;
    code: string;
    name: string;
    valueType: string;
    defaultValue: unknown;
  }>;
}

interface IssueResult {
  id: string;
  licenseKey: string;
  adminStatus: string;
  startsAt: string | null;
  expiresAt: string | null;
  durationLabel: string;
}

const DURATION_CHOICES = [
  ...DURATION_PRESETS,
  { id: "custom", label: "自定义", duration: { unit: "day" as const, value: 45 } },
];

/**
 * 签发授权抽屉（规格 7.1 / 7.2）。
 * 表单真实提交到 POST /api/v1/admin/licenses，成功后一次性展示兑换码。
 */
export function LicenseIssueDrawer({
  open,
  onOpenChange,
  onIssued,
  defaultProductId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: () => void;
  defaultProductId?: string;
}) {
  const lookups = useResource<Lookups>(open ? "/api/v1/admin/lookups" : null);
  const [productId, setProductId] = useState(defaultProductId ?? "");
  const [customerId, setCustomerId] = useState("");
  const [planId, setPlanId] = useState<string>("none");
  const [durationId, setDurationId] = useState("30d");
  const [customUnit, setCustomUnit] = useState<"day" | "month">("day");
  const [customValue, setCustomValue] = useState("45");
  const [startPolicy, setStartPolicy] = useState<"on_first_activation" | "fixed_start">("on_first_activation");
  const [startsAt, setStartsAt] = useState("");
  const [activationDeadline, setActivationDeadline] = useState("");
  const [maxDevices, setMaxDevices] = useState("1");
  const [maxActivationCount, setMaxActivationCount] = useState("");
  const [maxSubjects, setMaxSubjects] = useState("");
  const [offlineAllowed, setOfflineAllowed] = useState(false);
  const [offlineGraceDays, setOfflineGraceDays] = useState("7");
  const [notes, setNotes] = useState("");
  const [externalOrderId, setExternalOrderId] = useState("");
  const [featureOverrides, setFeatureOverrides] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<IssueResult | null>(null);

  const products = (lookups.data?.products ?? []).filter((product) => product.status === "active");
  const plans = (lookups.data?.plans ?? []).filter((plan) => plan.productId === productId);
  const selectedPlan = plans.find((plan) => plan.id === planId);
  const productFeatures = (lookups.data?.features ?? []).filter(
    (feature) => feature.productId === productId && feature.valueType === "boolean",
  );

  // 选择套餐时预填套餐策略（仍允许覆盖）
  useEffect(() => {
    if (!selectedPlan) return;
    setDurationId(
      selectedPlan.duration.unit === "lifetime"
        ? "lifetime"
        : selectedPlan.duration.unit === "month" && selectedPlan.duration.value === 3
          ? "1q"
          : selectedPlan.duration.unit === "month" && selectedPlan.duration.value === 12
            ? "1y"
            : selectedPlan.duration.unit === "day" && selectedPlan.duration.value === 30
              ? "30d"
              : "custom",
    );
    if (selectedPlan.duration.unit !== "lifetime") {
      setCustomUnit(selectedPlan.duration.unit);
      setCustomValue(String(selectedPlan.duration.value));
    }
    setMaxDevices(String(selectedPlan.maxDevices));
    setMaxActivationCount(selectedPlan.maxActivationCount ? String(selectedPlan.maxActivationCount) : "");
    setMaxSubjects(selectedPlan.maxSubjects ? String(selectedPlan.maxSubjects) : "");
    setStartPolicy(selectedPlan.startPolicy === "fixed_start" ? "fixed_start" : "on_first_activation");
    setOfflineAllowed(selectedPlan.offlineAllowed);
    setOfflineGraceDays(String(Math.round(selectedPlan.offlineGraceSeconds / 86400)));
  }, [selectedPlan]);

  const chosenDuration = useMemo(() => {
    if (durationId === "custom") {
      return { unit: customUnit, value: Number(customValue) || 0 };
    }
    const preset = DURATION_PRESETS.find((item) => item.id === durationId);
    return preset?.duration ?? { unit: "day" as const, value: 30 };
  }, [durationId, customUnit, customValue]);

  const reset = () => {
    setResult(null);
    setError(null);
    setFieldErrors({});
    setPlanId("none");
    setNotes("");
    setExternalOrderId("");
    setFeatureOverrides({});
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const payload = {
        productId,
        customerId,
        planId: planId === "none" ? null : planId,
        duration: chosenDuration,
        startPolicy,
        startsAt: startPolicy === "fixed_start" && startsAt ? new Date(startsAt).toISOString() : null,
        activationDeadlineAt: activationDeadline ? new Date(activationDeadline).toISOString() : null,
        maxDevices: Number(maxDevices) || 1,
        maxActivationCount: maxActivationCount ? Number(maxActivationCount) : null,
        maxSubjects: maxSubjects ? Number(maxSubjects) : null,
        offlineAllowed,
        offlineGraceSeconds: offlineAllowed ? Number(offlineGraceDays || 0) * 86400 : 0,
        features: Object.keys(featureOverrides).length > 0 ? featureOverrides : undefined,
        notes: notes || null,
        externalOrderId: externalOrderId || null,
        publish: true,
      };
      const issued = await apiRequest<IssueResult>("/api/v1/admin/licenses", {
        method: "POST",
        body: payload,
      });
      setResult(issued);
      toast.success("授权已签发，兑换码仅显示一次");
      onIssued?.();
    } catch (cause) {
      if (cause instanceof ClientApiError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors);
        if (Object.keys(cause.fieldErrors).length === 0) toast.error(cause.message);
      } else {
        setError("签发失败，请稍后重试");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={(next) => (submitting ? null : onOpenChange(next))} direction="right">
      <DrawerContent className="w-full sm:max-w-[560px]">
        <DrawerHeader className="border-b border-border">
          <DrawerTitle>签发授权</DrawerTitle>
          <DrawerDescription>
            授权主体是 License，兑换码只是激活凭证；重发兑换码不会创建第二份授权。
          </DrawerDescription>
        </DrawerHeader>

        {result ? (
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <SecretReveal
              title="授权已签发"
              description={`客户可使用该兑换码在客户端激活，到期时间：${result.expiresAt ? formatDateTime(result.expiresAt) : "永久"}`}
              secrets={[{ label: "兑换码（仅显示一次）", value: result.licenseKey }]}
              warning="关闭抽屉后无法再次查看明文；如客户丢失，请使用“重发兑换码”。"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={reset}>
                继续签发
              </Button>
              <Button asChild>
                <Link href={`/app/licenses/${result.id}`}>查看授权详情</Link>
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="产品" htmlFor="product" required error={fieldErrors.productId}>
                  <Select
                    value={productId}
                    onValueChange={(value) => {
                      setProductId(value);
                      setPlanId("none");
                      setFeatureOverrides({});
                    }}
                  >
                    <SelectTrigger id="product" className="w-full">
                      <SelectValue placeholder="选择产品" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((product) => (
                        <SelectItem key={product.id} value={product.id}>
                          {product.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>

                <FormField label="客户" htmlFor="customer" required error={fieldErrors.customerId}>
                  <Select value={customerId} onValueChange={setCustomerId}>
                    <SelectTrigger id="customer" className="w-full">
                      <SelectValue placeholder="选择客户" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {lookups.data?.customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.name}
                          {customer.email ? ` · ${customer.email}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <FormField
                label="套餐（可选）"
                htmlFor="plan"
                hint="选择套餐会预填周期、设备数与离线策略；不选则完全自定义。"
              >
                <Select value={planId} onValueChange={setPlanId} disabled={!productId}>
                  <SelectTrigger id="plan" className="w-full">
                    <SelectValue placeholder="不基于套餐" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不基于套餐（自定义）</SelectItem>
                    {plans.map((plan) => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.name} · {plan.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <Separator />

              <FormField label="授权周期" required hint="季度与一年按自然月计算，不是固定 90 / 365 天。">
                <div className="flex flex-wrap gap-1.5">
                  {DURATION_CHOICES.map((choice) => (
                    <Button
                      key={choice.id}
                      type="button"
                      size="xs"
                      variant={durationId === choice.id ? "default" : "outline"}
                      onClick={() => setDurationId(choice.id)}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </div>
              </FormField>

              {durationId === "custom" ? (
                <div className="grid grid-cols-2 gap-2">
                  <FormField label="单位" htmlFor="custom-unit">
                    <Select value={customUnit} onValueChange={(value) => setCustomUnit(value as "day" | "month")}>
                      <SelectTrigger id="custom-unit" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="day">天（精确 24 小时）</SelectItem>
                        <SelectItem value="month">自然月</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="数量" htmlFor="custom-value" error={fieldErrors["duration.value"]}>
                    <Input
                      id="custom-value"
                      type="number"
                      min={1}
                      value={customValue}
                      onChange={(event) => setCustomValue(event.target.value)}
                    />
                  </FormField>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="起算方式" htmlFor="start-policy">
                  <Select
                    value={startPolicy}
                    onValueChange={(value) => setStartPolicy(value as typeof startPolicy)}
                  >
                    <SelectTrigger id="start-policy" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on_first_activation">首次激活起算</SelectItem>
                      <SelectItem value="fixed_start">固定开始时间</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  label="首次激活截止"
                  htmlFor="activation-deadline"
                  hint="留空表示不限制"
                >
                  <Input
                    id="activation-deadline"
                    type="datetime-local"
                    value={activationDeadline}
                    onChange={(event) => setActivationDeadline(event.target.value)}
                  />
                </FormField>
              </div>

              {startPolicy === "fixed_start" ? (
                <FormField label="开始时间" htmlFor="starts-at" required error={fieldErrors.startsAt}>
                  <Input
                    id="starts-at"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(event) => setStartsAt(event.target.value)}
                  />
                </FormField>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label="最大设备数" htmlFor="max-devices" required error={fieldErrors.maxDevices}>
                  <Input
                    id="max-devices"
                    type="number"
                    min={1}
                    value={maxDevices}
                    onChange={(event) => setMaxDevices(event.target.value)}
                  />
                </FormField>
                <FormField label="累计激活次数" htmlFor="max-activations" hint="留空不限">
                  <Input
                    id="max-activations"
                    type="number"
                    min={1}
                    value={maxActivationCount}
                    onChange={(event) => setMaxActivationCount(event.target.value)}
                  />
                </FormField>
                <FormField label="最大账号数" htmlFor="max-subjects" hint="留空不限">
                  <Input
                    id="max-subjects"
                    type="number"
                    min={1}
                    value={maxSubjects}
                    onChange={(event) => setMaxSubjects(event.target.value)}
                  />
                </FormField>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div className="space-y-0.5">
                  <p className="text-sm text-foreground">允许离线授权</p>
                  <p className="text-xs text-muted-foreground">离线文件需要签名密钥，超过宽限期必须联网校验</p>
                </div>
                <Switch checked={offlineAllowed} onCheckedChange={setOfflineAllowed} aria-label="允许离线授权" />
              </div>
              {offlineAllowed ? (
                <FormField label="离线宽限期（天）" htmlFor="grace">
                  <Input
                    id="grace"
                    type="number"
                    min={0}
                    max={365}
                    value={offlineGraceDays}
                    onChange={(event) => setOfflineGraceDays(event.target.value)}
                  />
                </FormField>
              ) : null}

              {productFeatures.length > 0 ? (
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkles className="size-3.5" aria-hidden /> 功能覆盖值（留空使用套餐/产品默认）
                  </div>
                  <div className="space-y-1.5">
                    {productFeatures.map((feature) => (
                      <label key={feature.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-foreground">
                          {feature.name}
                          <span className="ml-1 font-mono text-[11px] text-muted-foreground">{feature.code}</span>
                        </span>
                        <Switch
                          checked={
                            feature.code in featureOverrides
                              ? Boolean(featureOverrides[feature.code])
                              : Boolean(feature.defaultValue)
                          }
                          onCheckedChange={(checked) =>
                            setFeatureOverrides((current) => ({ ...current, [feature.code]: checked }))
                          }
                          aria-label={`功能 ${feature.name}`}
                        />
                      </label>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    已禁用产品的功能不能被授权强行开启；覆盖值会写入授权快照。
                  </p>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="外部订单号" htmlFor="order-id" hint="用于与销售系统对账">
                  <Input
                    id="order-id"
                    value={externalOrderId}
                    onChange={(event) => setExternalOrderId(event.target.value)}
                    placeholder="ORD-2026-0001"
                  />
                </FormField>
                <FormField label="备注" htmlFor="notes">
                  <Input
                    id="notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="可选"
                  />
                </FormField>
              </div>

              <FormHint>签发后会写入审计日志；兑换码明文只出现一次。</FormHint>
              <FormError message={error} />
            </div>

            <DrawerFooter className="border-t border-border">
              <Button type="submit" disabled={submitting || !productId || !customerId}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {submitting ? "正在签发…" : "签发并生成兑换码"}
              </Button>
              <DrawerClose asChild>
                <Button type="button" variant="ghost" disabled={submitting}>
                  取消
                </Button>
              </DrawerClose>
            </DrawerFooter>
          </form>
        )}
      </DrawerContent>
    </Drawer>
  );
}
