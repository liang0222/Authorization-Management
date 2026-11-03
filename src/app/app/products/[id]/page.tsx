"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  Fingerprint,
  KeyRound,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Ticket,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, InfoGrid, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/app/feedback";
import { FormError, FormField } from "@/components/app/form-field";
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import { StatusBars } from "@/components/app/charts";
import {
  EditProductDialog,
  PRODUCT_STATUS_LABEL,
  PRODUCT_TYPE_LABEL,
  type ProductDetail,
} from "@/components/catalog/product-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";
import { durationLabel, formatDateTime, formatNumber } from "@/lib/format";

const STATUS_TONE: Record<string, Tone> = { active: "success", disabled: "warning", archived: "neutral" };

const EFFECTIVE_LABEL: Record<string, string> = {
  active: "生效中",
  pending: "待激活",
  draft: "草稿",
  suspended: "已暂停",
  expired: "已过期",
  revoked: "已撤销",
  cancelled: "已取消",
};

const VALUE_TYPE_LABEL: Record<string, string> = {
  boolean: "布尔值",
  number: "数值",
  string: "文本",
  json: "JSON",
};

interface FeatureRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  valueType: string;
  defaultValue: unknown;
  status: string;
  createdAt: string;
}

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  clientId: string;
  status: string;
  scopes: string[];
  allowedOrigins: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

interface PlanSummaryRow {
  id: string;
  code: string;
  name: string;
  durationUnit: string;
  durationValue: number;
  maxDevices: number;
  status: string;
}

interface ProductDetailResponse {
  product: ProductDetail;
  features: FeatureRow[];
  credentials: CredentialRow[];
  plans: PlanSummaryRow[];
  counts: {
    activeDevices: number;
    licenses: number;
    webhooks: number;
    signingKeys: number;
    /** 接口返回的是「状态 → 数量」的对象，不是数组，aggregation 在服务端已完成。 */
    licenseByStatus: Record<string, number>;
  };
}

function defaultValueToText(value: unknown): string {
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

function CreateFeatureDialog({
  open,
  onOpenChange,
  productId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  onCreated: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState("boolean");
  const [defaultValue, setDefaultValue] = useState("true");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) return;
    setCode("");
    setName("");
    setDescription("");
    setValueType("boolean");
    setDefaultValue("true");
    setError(null);
    setFieldErrors({});
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
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
      onCreated();
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
          <DialogTitle>添加功能权限</DialogTitle>
          <DialogDescription>
            功能编码是客户端读取权限的键名，签发后不可改名；修改名称不会影响已签发授权的取值。
          </DialogDescription>
        </DialogHeader>
        <form id="create-feature-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="功能编码" htmlFor="feature-code" required error={fieldErrors.code ?? null} hint="小写字母、数字、_ 与 .">
              <Input
                id="feature-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="advanced_settings"
                className="font-mono text-xs"
                required
              />
            </FormField>
            <FormField label="功能名称" htmlFor="feature-name" required error={fieldErrors.name ?? null}>
              <Input id="feature-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="高级设置" required />
            </FormField>
          </div>
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
            <FormField label="取值类型" required>
              <Select
                value={valueType}
                onValueChange={(value) => {
                  setValueType(value);
                  setDefaultValue(value === "boolean" ? "true" : value === "number" ? "0" : value === "json" ? "{}" : "");
                }}
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
            <FormField label="默认值" htmlFor="feature-default" required error={fieldErrors.defaultValue ?? null}>
              <Input
                id="feature-default"
                value={defaultValue}
                onChange={(event) => setDefaultValue(event.target.value)}
                className="font-mono text-xs"
                required
              />
            </FormField>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="create-feature-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            添加功能
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductDetailInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const productId = params.id;
  const { hasPermission, status: sessionStatus, session } = useSession();
  const canRead = hasPermission("product:read");
  const canWrite = hasPermission("product:write");
  const denied = sessionStatus === "ready" && !canRead;

  const [editOpen, setEditOpen] = useState(false);
  const [featureOpen, setFeatureOpen] = useState(false);
  const [tab, setTab] = useState("overview");

  const { data, error, isLoading, isRefreshing, refresh } = useResource<ProductDetailResponse>(
    canRead ? `/api/v1/admin/products/${productId}` : null,
  );

  const featureColumns: DataColumn<FeatureRow>[] = [
    {
      key: "name",
      header: "功能",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{row.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{row.code}</p>
        </div>
      ),
    },
    {
      key: "valueType",
      header: "类型",
      cell: (row) => <ToneBadge tone="neutral" dot={false}>{VALUE_TYPE_LABEL[row.valueType] ?? row.valueType}</ToneBadge>,
      width: "90px",
    },
    {
      key: "defaultValue",
      header: "默认值",
      cell: (row) => (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
          {defaultValueToText(row.defaultValue) || "—"}
        </code>
      ),
      width: "140px",
    },
    {
      key: "description",
      header: "说明",
      cell: (row) => <span className="text-[11px] text-muted-foreground">{row.description ?? "—"}</span>,
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => (
        <ToneBadge tone={row.status === "active" ? "success" : "neutral"}>
          {row.status === "active" ? "生效中" : "已归档"}
        </ToneBadge>
      ),
      width: "90px",
    },
  ];

  const planColumns: DataColumn<PlanSummaryRow>[] = [
    {
      key: "name",
      header: "套餐",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{row.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{row.code}</p>
        </div>
      ),
    },
    {
      key: "duration",
      header: "标准周期",
      cell: (row) => (
        <span className="text-xs text-foreground">
          {durationLabel({ unit: row.durationUnit as "day" | "month" | "lifetime", value: row.durationValue })}
        </span>
      ),
      width: "180px",
    },
    {
      key: "maxDevices",
      header: "设备上限",
      align: "right",
      cell: (row) => <span className="tabular text-xs">{row.maxDevices}</span>,
      width: "90px",
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => (
        <ToneBadge tone={row.status === "active" ? "success" : "neutral"}>
          {row.status === "active" ? "启用" : row.status === "disabled" ? "停用" : "已归档"}
        </ToneBadge>
      ),
      width: "90px",
    },
  ];

  const credentialColumns: DataColumn<CredentialRow>[] = [
    {
      key: "name",
      header: "凭证",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{row.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{row.clientId}</p>
        </div>
      ),
    },
    {
      key: "type",
      header: "类型",
      cell: (row) => (
        <ToneBadge tone={row.type === "confidential_server" ? "brand" : "info"} dot={false}>
          {row.type === "confidential_server" ? "机密服务端" : "公开客户端"}
        </ToneBadge>
      ),
      width: "110px",
    },
    {
      key: "scopes",
      header: "授权范围",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.scopes.slice(0, 3).map((scope) => (
            <span key={scope} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {scope}
            </span>
          ))}
          {row.scopes.length > 3 ? (
            <span className="text-[10px] text-muted-foreground">+{row.scopes.length - 3}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "lastUsedAt",
      header: "最近使用",
      cell: (row) => (
        <span className="text-[11px] text-muted-foreground">
          {row.lastUsedAt ? formatDateTime(row.lastUsedAt) : "从未使用"}
        </span>
      ),
      width: "160px",
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => (
        <ToneBadge tone={row.status === "active" ? "success" : row.status === "disabled" ? "warning" : "neutral"}>
          {row.status === "active" ? "启用" : row.status === "disabled" ? "停用" : "已归档"}
        </ToneBadge>
      ),
      width: "90px",
    },
  ];

  if (denied) {
    return (
      <EmptyState
        icon={<Boxes className="size-5" />}
        title="没有查看产品的权限"
        description="需要 product:read 权限，接口同样会拒绝这次请求。"
        action={
          <Button variant="outline" size="sm" onClick={() => router.push("/app/dashboard")}>
            返回数据总览
          </Button>
        }
      />
    );
  }

  if (error) {
    return <ErrorState error={error} onRetry={refresh} />;
  }

  if (isLoading || !data) {
    return <DetailSkeleton />;
  }

  const { product, features, credentials, plans, counts } = data;
  const STATUS_TONE_MAP: Record<string, Tone> = {
    active: "success",
    pending: "info",
    suspended: "warning",
    expired: "neutral",
    revoked: "danger",
    cancelled: "neutral",
    draft: "neutral",
  };
  const licenseStatusItems = Object.entries(counts.licenseByStatus ?? {}).map(([status, count]) => ({
    label: EFFECTIVE_LABEL[status] ?? status,
    value: Number(count) || 0,
    tone: STATUS_TONE_MAP[status] ?? "neutral",
  }));
  const licenseStatusTotal = licenseStatusItems.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[
          { label: "业务管理" },
          { label: "软件产品", href: "/app/products" },
          { label: product.name },
        ]}
        title={product.name}
        description={product.description ?? "这个产品还没有填写描述。"}
        meta={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <ToneBadge tone={STATUS_TONE[product.status] ?? "neutral"}>
              {PRODUCT_STATUS_LABEL[product.status] ?? product.status}
            </ToneBadge>
            <span className="font-mono text-foreground">{product.code}</span>
            <span>{PRODUCT_TYPE_LABEL[product.type] ?? product.type}</span>
            <span>
              版本 <span className="font-mono text-foreground">{product.currentVersion ?? "未标注"}</span>
            </span>
            <span>时区基准 {session?.organization.timezone ?? "Asia/Shanghai"}</span>
          </div>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => router.push("/app/products")}>
              <ArrowLeft className="size-3.5" /> 返回列表
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw className={cnSpin(isRefreshing)} /> 刷新
            </Button>
            {canWrite ? (
              <Button size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="size-3.5" /> 编辑产品
              </Button>
            ) : null}
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="features">
            功能权限 <span className="tabular ml-1 text-[10px] text-muted-foreground">{features.length}</span>
          </TabsTrigger>
          <TabsTrigger value="plans">
            套餐 <span className="tabular ml-1 text-[10px] text-muted-foreground">{plans.length}</span>
          </TabsTrigger>
          <TabsTrigger value="credentials">
            API 凭证 <span className="tabular ml-1 text-[10px] text-muted-foreground">{credentials.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-3">
          <Section title="产品档案" description="接入客户端时需要的运行时参数。">
            <InfoGrid
              columns={3}
              items={[
                { label: "产品编码", value: product.code, mono: true },
                { label: "产品类型", value: PRODUCT_TYPE_LABEL[product.type] ?? product.type },
                { label: "当前版本", value: product.currentVersion ?? "未标注", mono: true },
                {
                  label: "心跳间隔",
                  value: `${product.heartbeatIntervalSeconds} 秒`,
                  hint: "客户端上报心跳的建议间隔",
                },
                {
                  label: "访问令牌有效期",
                  value: `${product.accessTokenTtlSeconds} 秒`,
                  hint: "每次心跳会轮换令牌",
                },
                {
                  label: "支持平台",
                  value: product.supportedPlatforms.length > 0 ? product.supportedPlatforms.join(" / ") : "未限定",
                  mono: true,
                },
                { label: "创建时间", value: formatDateTime(product.createdAt) },
                { label: "最近更新", value: formatDateTime(product.updatedAt) },
                { label: "累计授权", value: formatNumber(counts.licenses) },
              ]}
            />
          </Section>

          <div className="grid gap-3 lg:grid-cols-2">
            <Section title="授权状态分布" description="按管理状态统计当前产品的全部授权。">
              {licenseStatusItems.length > 0 ? (
                <StatusBars items={licenseStatusItems} total={licenseStatusTotal} />
              ) : (
                <EmptyState title="还没有授权" description="签发第一份授权后这里会显示状态分布。" />
              )}
            </Section>

            <Section title="接入资源" description="客户端校验依赖这些资源。">
              <div className="grid gap-2 sm:grid-cols-2">
                <ResourceTile icon={<Fingerprint className="size-4" />} label="签名密钥" value={`${counts.signingKeys} 把`} href="/app/security/signing-keys" />
                <ResourceTile icon={<KeyRound className="size-4" />} label="API 凭证" value={`${credentials.length} 个`} href="/app/developer/credentials" />
                <ResourceTile icon={<Ticket className="size-4" />} label="Webhook" value={`${counts.webhooks} 个`} href="/app/developer/webhooks" />
                <ResourceTile icon={<SlidersHorizontal className="size-4" />} label="活跃设备" value={`${formatNumber(counts.activeDevices)} 台`} href={`/app/devices?productId=${product.id}`} />
              </div>
            </Section>
          </div>
        </TabsContent>

        <TabsContent value="features">
          <Section
            title="功能权限定义"
            description="功能编码是客户端读取权限的键名；套餐在这里选默认值，单份授权还可以覆盖。"
            actions={
              canWrite ? (
                <Button size="sm" variant="outline" onClick={() => setFeatureOpen(true)}>
                  <Plus className="size-3.5" /> 添加功能
                </Button>
              ) : null
            }
          >
            <DataTable
              columns={featureColumns}
              rows={features}
              rowKey={(row) => row.id}
              caption="功能权限列表"
              dense
              empty={<EmptyState title="还没有功能权限" description="先定义功能，套餐才能引用它们。" />}
            />
          </Section>
        </TabsContent>

        <TabsContent value="plans">
          <Section
            title="授权套餐"
            description="套餐把标准周期、设备上限与功能默认值打包，签发授权时一键套用。"
            actions={
              <Button size="sm" variant="outline" asChild>
                <Link href={`/app/plans?productId=${product.id}`}>
                  <Package className="size-3.5" /> 管理套餐
                </Link>
              </Button>
            }
          >
            <DataTable
              columns={planColumns}
              rows={plans}
              rowKey={(row) => row.id}
              caption="套餐列表"
              dense
              empty={<EmptyState title="还没有套餐" description="创建套餐后，签发授权时可直接选择标准周期与设备上限。" />}
            />
          </Section>
        </TabsContent>

        <TabsContent value="credentials">
          <Section
            title="API 凭证"
            description="公开客户端用于桌面/扩展，机密服务端用于后端到后端调用；密钥只在创建时展示一次。"
            actions={
              <Button size="sm" variant="outline" asChild>
                <Link href={`/app/developer/credentials?productId=${product.id}`}>
                  <KeyRound className="size-3.5" /> 管理凭证
                </Link>
              </Button>
            }
          >
            <DataTable
              columns={credentialColumns}
              rows={credentials}
              rowKey={(row) => row.id}
              caption="API 凭证列表"
              dense
              empty={<EmptyState title="还没有 API 凭证" description="没有凭证时，客户端无法调用激活与校验接口。" />}
            />
          </Section>
        </TabsContent>
      </Tabs>

      {canWrite ? (
        <>
          <EditProductDialog open={editOpen} onOpenChange={setEditOpen} product={product} onSaved={refresh} />
          <CreateFeatureDialog
            open={featureOpen}
            onOpenChange={setFeatureOpen}
            productId={product.id}
            onCreated={refresh}
          />
        </>
      ) : null}
    </div>
  );
}

function ResourceTile({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-muted-foreground">{label}</span>
        <span className="block truncate text-xs font-medium text-foreground">{value}</span>
      </span>
    </Link>
  );
}

function cnSpin(spinning: boolean) {
  return `size-3.5${spinning ? " animate-spin" : ""}`;
}

export default function ProductDetailPage() {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <ProductDetailInner />
    </Suspense>
  );
}
