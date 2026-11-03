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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";

export const PRODUCT_TYPE_OPTIONS = [
  { value: "desktop", label: "桌面应用" },
  { value: "browser_extension", label: "浏览器扩展" },
  { value: "mini_program", label: "小程序" },
  { value: "web", label: "Web 应用" },
  { value: "server", label: "服务端 / SDK" },
  { value: "other", label: "其他" },
] as const;

export const PRODUCT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  PRODUCT_TYPE_OPTIONS.map((item) => [item.value, item.label]),
);

export const PLATFORM_OPTIONS = [
  "windows",
  "macos",
  "linux",
  "chrome",
  "edge",
  "firefox",
  "wechat",
  "android",
  "ios",
  "web",
] as const;

export const PRODUCT_STATUS_LABEL: Record<string, string> = {
  active: "已上线",
  disabled: "已停用",
  archived: "已归档",
};

export interface ProductFormValues {
  code: string;
  name: string;
  description: string;
  productType: string;
  currentVersion: string;
  supportedPlatforms: string[];
  heartbeatIntervalSeconds: number;
  accessTokenTtlSeconds: number;
}

const EMPTY_FORM: ProductFormValues = {
  code: "",
  name: "",
  description: "",
  productType: "desktop",
  currentVersion: "",
  supportedPlatforms: ["windows", "macos", "linux"],
  heartbeatIntervalSeconds: 900,
  accessTokenTtlSeconds: 600,
};

type FieldErrors = Record<string, string>;

function fieldError(errors: FieldErrors, key: string): string | null {
  return errors[key] ?? null;
}

/** 新建产品：编码创建后不可修改，因为它是客户端请求头与日志里的稳定标识。 */
export function CreateProductDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<ProductFormValues>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_FORM);
      setError(null);
      setFieldErrors({});
      setSubmitting(false);
    }
  }, [open]);

  const patch = (next: Partial<ProductFormValues>) => setForm((prev) => ({ ...prev, ...next }));

  const togglePlatform = (platform: string, checked: boolean) =>
    patch({
      supportedPlatforms: checked
        ? [...form.supportedPlatforms, platform]
        : form.supportedPlatforms.filter((item) => item !== platform),
    });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await apiRequest<{ id: string }>("/api/v1/admin/products", {
        method: "POST",
        body: {
          code: form.code.trim(),
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          productType: form.productType,
          currentVersion: form.currentVersion.trim() || undefined,
          supportedPlatforms: form.supportedPlatforms,
          heartbeatIntervalSeconds: form.heartbeatIntervalSeconds,
          accessTokenTtlSeconds: form.accessTokenTtlSeconds,
        },
      });
      toast.success("产品已创建", { description: `${form.name} 现在可以签发授权与配置凭证了。` });
      onCreated(result.id);
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
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新建软件产品</DialogTitle>
          <DialogDescription>
            产品是授权的最小归属单位：授权、套餐、功能权限与 API 凭证都挂在产品下。
          </DialogDescription>
        </DialogHeader>

        <form id="create-product-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="产品编码" htmlFor="product-code" required error={fieldError(fieldErrors, "code")} hint="小写字母、数字、- 与 _，创建后不可改。">
              <Input
                id="product-code"
                value={form.code}
                onChange={(event) => patch({ code: event.target.value })}
                placeholder="fluxpanel-desktop"
                className="font-mono text-xs"
                autoComplete="off"
                required
              />
            </FormField>
            <FormField label="产品名称" htmlFor="product-name" required error={fieldError(fieldErrors, "name")}>
              <Input
                id="product-name"
                value={form.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="FluxPanel 桌面版"
                required
              />
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="产品类型" required error={fieldError(fieldErrors, "productType")}>
              <Select value={form.productType} onValueChange={(value) => patch({ productType: value })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="当前版本" htmlFor="product-version" error={fieldError(fieldErrors, "currentVersion")}>
              <Input
                id="product-version"
                value={form.currentVersion}
                onChange={(event) => patch({ currentVersion: event.target.value })}
                placeholder="2.0.7"
                className="font-mono text-xs"
              />
            </FormField>
          </div>

          <FormField label="产品描述" htmlFor="product-description" error={fieldError(fieldErrors, "description")}>
            <Textarea
              id="product-description"
              value={form.description}
              onChange={(event) => patch({ description: event.target.value })}
              rows={2}
              placeholder="一句话说明这个产品做什么，便于团队内区分。"
            />
          </FormField>

          <FormField label="支持平台" hint="用于设备列表展示与客户端上报校验，可多选。">
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2">
              {PLATFORM_OPTIONS.map((platform) => (
                <label key={platform} className="flex items-center gap-1.5 text-xs text-foreground">
                  <Checkbox
                    checked={form.supportedPlatforms.includes(platform)}
                    onCheckedChange={(checked) => togglePlatform(platform, checked === true)}
                  />
                  <span className="font-mono">{platform}</span>
                </label>
              ))}
            </div>
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="心跳间隔（秒）"
              htmlFor="product-heartbeat"
              error={fieldError(fieldErrors, "heartbeatIntervalSeconds")}
              hint="60–86400，默认 900。"
            >
              <Input
                id="product-heartbeat"
                type="number"
                min={60}
                max={86400}
                value={form.heartbeatIntervalSeconds}
                onChange={(event) => patch({ heartbeatIntervalSeconds: Number(event.target.value) })}
                className="tabular"
              />
            </FormField>
            <FormField
              label="访问令牌有效期（秒）"
              htmlFor="product-token-ttl"
              error={fieldError(fieldErrors, "accessTokenTtlSeconds")}
              hint="60–3600，默认 600。"
            >
              <Input
                id="product-token-ttl"
                type="number"
                min={60}
                max={3600}
                value={form.accessTokenTtlSeconds}
                onChange={(event) => patch({ accessTokenTtlSeconds: Number(event.target.value) })}
                className="tabular"
              />
            </FormField>
          </div>

          <FormHint>创建后编码不可修改；若编码写错，请新建产品并把旧产品归档。</FormHint>
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="create-product-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            创建产品
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ProductDetail {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  currentVersion: string | null;
  supportedPlatforms: string[];
  heartbeatIntervalSeconds: number;
  accessTokenTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
}

/** 编辑产品：状态用 Switch 即时保存（规格 15.7），其余字段走保存按钮。 */
export function EditProductDialog({
  open,
  onOpenChange,
  product,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductDetail;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ProductFormValues>({
    code: product.code,
    name: product.name,
    description: product.description ?? "",
    productType: product.type,
    currentVersion: product.currentVersion ?? "",
    supportedPlatforms: product.supportedPlatforms ?? [],
    heartbeatIntervalSeconds: product.heartbeatIntervalSeconds,
    accessTokenTtlSeconds: product.accessTokenTtlSeconds,
  });
  const [status, setStatus] = useState(product.status);
  const [savingStatus, setSavingStatus] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!open) return;
    setForm({
      code: product.code,
      name: product.name,
      description: product.description ?? "",
      productType: product.type,
      currentVersion: product.currentVersion ?? "",
      supportedPlatforms: product.supportedPlatforms ?? [],
      heartbeatIntervalSeconds: product.heartbeatIntervalSeconds,
      accessTokenTtlSeconds: product.accessTokenTtlSeconds,
    });
    setStatus(product.status);
    setError(null);
    setFieldErrors({});
  }, [open, product]);

  const patch = (next: Partial<ProductFormValues>) => setForm((prev) => ({ ...prev, ...next }));

  const togglePlatform = (platform: string, checked: boolean) =>
    patch({
      supportedPlatforms: checked
        ? [...form.supportedPlatforms, platform]
        : form.supportedPlatforms.filter((item) => item !== platform),
    });

  const saveStatus = async (next: boolean) => {
    const nextStatus = next ? "active" : "disabled";
    const previous = status;
    setStatus(nextStatus);
    setSavingStatus(true);
    try {
      await apiRequest(`/api/v1/admin/products/${product.id}`, {
        method: "PATCH",
        body: { status: nextStatus },
      });
      toast.success(next ? "产品已启用" : "产品已停用", {
        description: next ? "客户端可以继续校验与激活。" : "停用后所有校验请求返回 403 PRODUCT_DISABLED。",
      });
      onSaved();
    } catch (err) {
      setStatus(previous);
      toast.error("状态切换失败", { description: errorMessage(err) });
    } finally {
      setSavingStatus(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiRequest(`/api/v1/admin/products/${product.id}`, {
        method: "PATCH",
        body: {
          name: form.name.trim(),
          description: form.description.trim() || null,
          currentVersion: form.currentVersion.trim() || null,
          supportedPlatforms: form.supportedPlatforms,
          heartbeatIntervalSeconds: form.heartbeatIntervalSeconds,
          accessTokenTtlSeconds: form.accessTokenTtlSeconds,
        },
      });
      toast.success("产品信息已保存");
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
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>编辑产品</DialogTitle>
          <DialogDescription>
            编码 <span className="font-mono">{product.code}</span> 是客户端与日志里的稳定标识，不可修改。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">产品启用状态</p>
            <p className="text-[11px] text-muted-foreground">开关即时保存，无需再点保存按钮。</p>
          </div>
          <Switch
            checked={status === "active"}
            disabled={savingStatus}
            onCheckedChange={saveStatus}
            aria-label="切换产品启用状态"
          />
        </div>

        <form id="edit-product-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />

          <FormField label="产品名称" htmlFor="edit-product-name" required error={fieldError(fieldErrors, "name")}>
            <Input
              id="edit-product-name"
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
              required
            />
          </FormField>

          <FormField label="产品描述" htmlFor="edit-product-description">
            <Textarea
              id="edit-product-description"
              value={form.description}
              onChange={(event) => patch({ description: event.target.value })}
              rows={2}
            />
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="当前版本" htmlFor="edit-product-version">
              <Input
                id="edit-product-version"
                value={form.currentVersion}
                onChange={(event) => patch({ currentVersion: event.target.value })}
                className="font-mono text-xs"
              />
            </FormField>
            <FormField label="产品类型" hint="类型影响接入示例与平台校验。">
              <Input value={PRODUCT_TYPE_LABEL[form.productType] ?? form.productType} readOnly className="bg-muted/50" />
            </FormField>
          </div>

          <FormField label="支持平台">
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2">
              {PLATFORM_OPTIONS.map((platform) => (
                <label key={platform} className="flex items-center gap-1.5 text-xs text-foreground">
                  <Checkbox
                    checked={form.supportedPlatforms.includes(platform)}
                    onCheckedChange={(checked) => togglePlatform(platform, checked === true)}
                  />
                  <span className="font-mono">{platform}</span>
                </label>
              ))}
            </div>
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="心跳间隔（秒）" htmlFor="edit-product-heartbeat" error={fieldError(fieldErrors, "heartbeatIntervalSeconds")}>
              <Input
                id="edit-product-heartbeat"
                type="number"
                min={60}
                max={86400}
                value={form.heartbeatIntervalSeconds}
                onChange={(event) => patch({ heartbeatIntervalSeconds: Number(event.target.value) })}
                className="tabular"
              />
            </FormField>
            <FormField label="访问令牌有效期（秒）" htmlFor="edit-product-token-ttl" error={fieldError(fieldErrors, "accessTokenTtlSeconds")}>
              <Input
                id="edit-product-token-ttl"
                type="number"
                min={60}
                max={3600}
                value={form.accessTokenTtlSeconds}
                onChange={(event) => patch({ accessTokenTtlSeconds: Number(event.target.value) })}
                className="tabular"
              />
            </FormField>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="edit-product-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
