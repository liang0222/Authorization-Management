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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, FormField, FormHint } from "@/components/app/form-field";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";

export const VALUE_TYPE_LABEL: Record<string, string> = {
  boolean: "布尔值（开 / 关）",
  number: "数值",
  string: "文本",
  json: "JSON",
};

export const FEATURE_STATUS_LABEL: Record<string, string> = {
  active: "生效中",
  archived: "已归档",
};

export interface FeatureFormInitial {
  id?: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  valueType: string;
  defaultValue: unknown;
  status?: string;
}

export function defaultValueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseDefaultValue(raw: string, valueType: string): unknown {
  const text = raw.trim();
  if (valueType === "boolean") return text === "true";
  if (valueType === "number") return Number(text || "0");
  if (valueType === "json") {
    try {
      return JSON.parse(text || "null");
    } catch {
      throw new Error("默认值不是合法 JSON");
    }
  }
  return text;
}

/** 功能权限表单：新建时选产品，编辑时产品与编码锁定（它们是客户端读权限的键）。 */
export function FeatureFormDialog({
  open,
  onOpenChange,
  products,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Array<{ id: string; name: string; code: string }>;
  initial?: FeatureFormInitial | null;
  onSaved: () => void;
}) {
  const isEdit = Boolean(initial?.id);
  const [productId, setProductId] = useState(initial?.productId ?? products[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState("boolean");
  const [defaultValue, setDefaultValue] = useState("true");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setProductId(initial.productId);
      setCode(initial.code);
      setName(initial.name);
      setDescription(initial.description ?? "");
      setValueType(initial.valueType);
      setDefaultValue(defaultValueToText(initial.defaultValue));
    } else {
      setProductId(products[0]?.id ?? "");
      setCode("");
      setName("");
      setDescription("");
      setValueType("boolean");
      setDefaultValue("true");
    }
    setError(null);
    setFieldErrors({});
  }, [open, initial, products]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      if (isEdit) {
        await apiRequest(`/api/v1/admin/features/${initial!.id}`, {
          method: "PATCH",
          body: {
            name: name.trim(),
            description: description.trim() || null,
            defaultValue: parseDefaultValue(defaultValue, valueType),
          },
        });
        toast.success("功能权限已保存", {
          description: "已签发授权中显式覆盖的取值不会改变，未覆盖的跟随新默认值。",
        });
      } else {
        await apiRequest(`/api/v1/admin/products/${productId}/features`, {
          method: "POST",
          body: {
            code: code.trim(),
            name: name.trim(),
            description: description.trim() || undefined,
            valueType,
            defaultValue: parseDefaultValue(defaultValue, valueType),
          },
        });
        toast.success("功能权限已添加", { description: `${name} 现在可以加入套餐默认值。` });
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
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑功能权限" : "添加功能权限"}</DialogTitle>
          <DialogDescription>
            功能编码是客户端读取权限的键名，创建后不可修改；修改名称不会影响已签发授权。
          </DialogDescription>
        </DialogHeader>

        <form id="feature-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="所属产品" required error={fieldErrors.productId}>
              <Select value={productId} onValueChange={setProductId} disabled={isEdit}>
                <SelectTrigger className="w-full">
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
            <FormField label="功能编码" htmlFor="feature-code" required error={fieldErrors.code} hint="小写字母、数字、_ 与 .">
              <Input
                id="feature-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="advanced_settings"
                className="font-mono text-xs"
                disabled={isEdit}
                required
              />
            </FormField>
          </div>

          <FormField label="功能名称" htmlFor="feature-name" required error={fieldErrors.name}>
            <Input
              id="feature-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="高级设置"
              required
            />
          </FormField>

          <FormField label="说明" htmlFor="feature-description">
            <Textarea
              id="feature-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="给运营看的解释，会出现在套餐与授权详情里。"
            />
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="取值类型" required hint={isEdit ? "类型创建后不可修改。" : undefined}>
              <Select
                value={valueType}
                onValueChange={(value) => {
                  setValueType(value);
                  setDefaultValue(value === "boolean" ? "true" : value === "number" ? "0" : value === "json" ? "{}" : "");
                }}
                disabled={isEdit}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(VALUE_TYPE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="默认值" htmlFor="feature-default" required error={fieldErrors.defaultValue}>
              <Input
                id="feature-default"
                value={defaultValue}
                onChange={(event) => setDefaultValue(event.target.value)}
                className="font-mono text-xs"
                required
              />
            </FormField>
          </div>

          <FormHint>取值类型必须与默认值匹配，否则接口返回 400 并定位到具体字段。</FormHint>
        </form>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="feature-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {isEdit ? "保存修改" : "添加功能"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
