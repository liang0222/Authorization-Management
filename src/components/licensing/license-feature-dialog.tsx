"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormError } from "@/components/app/form-field";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { useResource } from "@/lib/client/use-resource";

/**
 * 授权级功能覆盖编辑器（P1-3）。
 *
 * 交互决策：
 * - **默认不覆盖**：每一行先显示「继承」状态，用户拨开 Switch 才进入编辑态。
 *   这样「我只是看一眼」不会不小心生成一堆覆盖值 —— 覆盖值会写进审计，
 *   事后很难说清是手滑还是有意。
 * - 只提交**被覆盖的行**，并且是全量替换（PUT）：关掉 Switch 就等于删掉这条覆盖，
 *   回落到套餐/产品默认值。前端不需要维护「删了哪条」的差异。
 * - 已停用的功能行仍然显示但禁用，并标注「产品已停用」：让用户知道
 *   「不是这里没做，是产品层关了」，避免反复提工单。
 */

interface FeatureDefinition {
  id: string;
  code: string;
  name: string;
  description: string | null;
  valueType: string;
  defaultValue: unknown;
  status: string;
}

interface FeaturesResponse {
  items: Array<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    valueType: string;
    defaultValue: unknown;
    status: string;
  }>;
}

type Draft = { enabled: boolean; value: string };

function valueToText(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseValue(type: string, text: string): unknown {
  if (type === "boolean") return text === "true";
  if (type === "number") {
    const num = Number(text);
    return Number.isFinite(num) ? num : 0;
  }
  return text;
}

export function LicenseFeatureDialog({
  open,
  onOpenChange,
  licenseId,
  productId,
  productName,
  snapshot,
  overrides,
  entitlementsVersion,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  licenseId: string;
  productId: string;
  productName: string;
  snapshot: Record<string, unknown>;
  overrides: Array<{ code: string; value: unknown }>;
  entitlementsVersion: number;
  onSaved?: () => void;
}) {
  const resource = useResource<FeaturesResponse>(
    open ? `/api/v1/admin/features?productId=${productId}&pageSize=100` : null,
  );
  const definitions = useMemo<FeatureDefinition[]>(() => {
    const items = resource.data?.items ?? [];
    return items.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      valueType: row.valueType,
      defaultValue: row.defaultValue,
      status: row.status,
    }));
  }, [resource.data]);

  const overrideMap = useMemo(() => new Map(overrides.map((row) => [row.code, row.value])), [overrides]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都用「当前真实状态」重建草稿，避免上次取消的编辑残留。
  useEffect(() => {
    if (!open) return;
    const next: Record<string, Draft> = {};
    for (const definition of definitions) {
      const isOverridden = overrideMap.has(definition.code);
      const effective = isOverridden ? overrideMap.get(definition.code) : snapshot[definition.code];
      next[definition.code] = {
        enabled: isOverridden,
        value: valueToText(effective ?? definition.defaultValue),
      };
    }
    setDrafts(next);
    setError(null);
  }, [open, definitions, overrideMap, snapshot]);

  const dirtyCount = useMemo(
    () => Object.values(drafts).filter((draft) => draft.enabled).length,
    [drafts],
  );

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = definitions
        .filter((definition) => drafts[definition.code]?.enabled)
        .map((definition) => ({
          code: definition.code,
          value: parseValue(definition.valueType, drafts[definition.code]?.value ?? ""),
        }));
      const result = await apiRequest<{ entitlements_version: number }>(
        `/api/v1/admin/licenses/${licenseId}/features`,
        { method: "PUT", body: { overrides: payload } },
      );
      toast.success(`功能权限已更新，权限版本升到 v${result.entitlements_version}`);
      onOpenChange(false);
      onSaved?.();
    } catch (cause) {
      if (cause instanceof ClientApiError) setError(cause.message);
      else setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? null : onOpenChange(next))}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>调整功能权限</DialogTitle>
          <DialogDescription>
            {productName} · 当前权限版本 v{entitlementsVersion}。拨开开关即覆盖该功能；关掉开关回落到套餐或产品默认值。
          </DialogDescription>
        </DialogHeader>

        {resource.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : resource.error ? (
          <FormError message={errorMessage(resource.error)} />
        ) : definitions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            该产品还没有定义功能权限，可以到产品详情页先添加功能编码。
          </p>
        ) : (
          <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-[1fr_88px_150px] items-center gap-3 border-b pb-2 text-[11px] font-medium text-muted-foreground">
              <span>功能</span>
              <span className="text-center">覆盖</span>
              <span>值</span>
            </div>
            {definitions.map((definition) => {
              const draft = drafts[definition.code] ?? { enabled: false, value: "" };
              const inherited = snapshot[definition.code];
              const disabled = definition.status !== "active";
              return (
                <div
                  key={definition.code}
                  className="grid grid-cols-[1fr_88px_150px] items-center gap-3 rounded-md px-1 py-2 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{definition.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{definition.code}</span>
                      {disabled ? (
                        <Badge variant="outline" className="text-[10px]">
                          产品已停用
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      继承值 {valueToText(inherited ?? definition.defaultValue)}
                      {definition.valueType ? ` · ${definition.valueType}` : ""}
                    </p>
                  </div>
                  <div className="flex justify-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Switch
                            checked={draft.enabled}
                            disabled={disabled || submitting}
                            aria-label={`覆盖 ${definition.name}`}
                            onCheckedChange={(checked) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [definition.code]: {
                                  ...draft,
                                  enabled: checked,
                                  value:
                                    draft.value ||
                                    valueToText(inherited ?? definition.defaultValue),
                                },
                              }))
                            }
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {disabled ? "产品层已停用该功能，不能单独为授权开启" : "开启后该值会写进授权快照，权限版本 +1"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {definition.valueType === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={draft.value === "true"}
                        disabled={!draft.enabled || submitting}
                        aria-label={`${definition.name} 值`}
                        onCheckedChange={(checked) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [definition.code]: { ...draft, value: checked ? "true" : "false" },
                          }))
                        }
                      />
                      <span className="font-mono text-xs text-muted-foreground">{draft.value || "—"}</span>
                    </div>
                  ) : (
                    <Input
                      value={draft.value}
                      disabled={!draft.enabled || submitting}
                      inputMode={definition.valueType === "number" ? "decimal" : "text"}
                      aria-label={`${definition.name} 值`}
                      className="h-8 font-mono text-xs"
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [definition.code]: { ...draft, value: event.target.value },
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <FormError message={error} />

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            {dirtyCount > 0 ? `将覆盖 ${dirtyCount} 个功能` : "没有覆盖，保存后回到套餐默认"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() =>
                setDrafts((prev) =>
                  Object.fromEntries(Object.entries(prev).map(([code, draft]) => [code, { ...draft, enabled: false }])),
                )
              }
            >
              <RotateCcw className="size-3.5" />
              全部回落
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="button" size="sm" disabled={submitting} onClick={save}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}