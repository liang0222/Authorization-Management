"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Pencil, Plus, RefreshCw, Ticket, UserRound } from "lucide-react";
import { PageHeader, InfoGrid, Section } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/components/app/data-table";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/app/feedback";
import { ToneBadge, type Tone } from "@/components/app/status-badge";
import { EditCustomerDialog } from "@/components/catalog/customer-dialogs";
import { useResource } from "@/lib/client/use-resource";
import { useSession } from "@/lib/client/session-context";
import { formatDateTime, formatRelative } from "@/lib/format";

interface CustomerLicenseRow {
  id: string;
  adminStatus: string;
  productName: string;
  durationUnit: "day" | "month" | "lifetime";
  durationValue: number;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface CustomerIdentityRow {
  id: string;
  provider: string;
  displayName: string | null;
  status: string;
  verifiedAt: string | null;
  createdAt: string;
}

interface CustomerDetailResponse {
  customer: {
    id: string;
    customerCode: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    companyName: string | null;
    notes: string | null;
    status: string;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
    licenseCount: number;
  };
  licenses: CustomerLicenseRow[];
  identities: CustomerIdentityRow[];
}

const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  active: "合作中",
  disabled: "已停用",
  archived: "已归档",
};

const CUSTOMER_STATUS_TONE: Record<string, Tone> = {
  active: "success",
  disabled: "warning",
  archived: "neutral",
};

const ADMIN_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending: "待激活",
  active: "已激活",
  suspended: "已暂停",
  revoked: "已撤销",
  cancelled: "已取消",
};

const ADMIN_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending: "info",
  active: "success",
  suspended: "warning",
  revoked: "danger",
  cancelled: "neutral",
};

function durationText(unit: string, value: number): string {
  if (unit === "lifetime") return "永久";
  if (unit === "month") return value === 3 ? "一季度（3 个自然月）" : value === 12 ? "一年（12 个自然月）" : `${value} 个自然月`;
  return `${value} 天`;
}

function CustomerDetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { status: sessionStatus, hasPermission } = useSession();
  const { data, error, isLoading, isRefreshing, refresh } = useResource<CustomerDetailResponse>(
    id ? `/api/v1/admin/customers/${id}` : null,
  );
  const [editOpen, setEditOpen] = useState(false);

  const canRead = sessionStatus !== "ready" || hasPermission("customer:read");
  const canWrite = hasPermission("customer:write");
  const canIssue = hasPermission("license:issue");

  const licenseColumns = useMemo<DataColumn<CustomerLicenseRow>[]>(
    () => [
      {
        key: "product",
        header: "产品",
        cell: (row) => <span className="text-xs font-medium text-foreground">{row.productName}</span>,
      },
      {
        key: "duration",
        header: "周期",
        cell: (row) => <span className="text-xs">{durationText(row.durationUnit, row.durationValue)}</span>,
        width: "170px",
      },
      {
        key: "status",
        header: "管理状态",
        cell: (row) => (
          <ToneBadge tone={ADMIN_STATUS_TONE[row.adminStatus] ?? "neutral"} dot>
            {ADMIN_STATUS_LABEL[row.adminStatus] ?? row.adminStatus}
          </ToneBadge>
        ),
        width: "110px",
      },
      {
        key: "window",
        header: "开始 / 到期",
        cell: (row) => (
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            <p>开始 {row.startsAt ? formatDateTime(row.startsAt) : "首次激活"}</p>
            <p>{row.expiresAt ? `到期 ${formatDateTime(row.expiresAt)}` : row.durationUnit === "lifetime" ? "永久有效" : `激活后 ${durationText(row.durationUnit, row.durationValue)}`}</p>
          </div>
        ),
        width: "190px",
      },
      {
        key: "createdAt",
        header: "签发时间",
        cell: (row) => <span className="text-[11px] text-muted-foreground">{formatRelative(row.createdAt)}</span>,
        width: "110px",
        className: "hidden md:table-cell",
        headerClassName: "hidden md:table-cell",
      },
      {
        key: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <Button variant="ghost" size="sm" asChild onClick={(event) => event.stopPropagation()}>
            <Link href={`/app/licenses/${row.id}`}>详情</Link>
          </Button>
        ),
        width: "80px",
      },
    ],
    [],
  );

  const identityColumns = useMemo<DataColumn<CustomerIdentityRow>[]>(
    () => [
      { key: "provider", header: "身份来源", cell: (row) => <span className="text-xs">{row.provider}</span> },
      {
        key: "displayName",
        header: "显示名",
        cell: (row) => <span className="text-xs text-muted-foreground">{row.displayName ?? "—"}</span>,
      },
      {
        key: "status",
        header: "状态",
        cell: (row) => (
          <ToneBadge tone={row.status === "verified" ? "success" : "neutral"} dot>
            {row.status === "verified" ? "已验证" : row.status}
          </ToneBadge>
        ),
        width: "100px",
      },
      {
        key: "verifiedAt",
        header: "验证时间",
        cell: (row) => (
          <span className="text-[11px] text-muted-foreground">
            {row.verifiedAt ? formatDateTime(row.verifiedAt) : "未验证"}
          </span>
        ),
        width: "160px",
      },
    ],
    [],
  );

  if (sessionStatus === "ready" && !canRead) {
    return (
      <EmptyState
        title="没有查看客户的权限"
        description="当前角色缺少 customer:read 权限，请联系所有者分配。"
        action={
          <Button size="sm" asChild>
            <Link href="/app/dashboard">返回数据总览</Link>
          </Button>
        }
      />
    );
  }

  if (isLoading) return <DetailSkeleton />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const { customer, licenses, identities } = data;

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumbs={[
          { label: "业务管理" },
          { label: "客户管理", href: "/app/customers" },
          { label: customer.name },
        ]}
        title={customer.name}
        description={customer.companyName ?? "未填写公司名称"}
        meta={
          <>
            <ToneBadge tone={CUSTOMER_STATUS_TONE[customer.status] ?? "neutral"} dot>
              {CUSTOMER_STATUS_LABEL[customer.status] ?? customer.status}
            </ToneBadge>
            {customer.customerCode ? (
              <span className="font-mono text-[11px] text-muted-foreground">{customer.customerCode}</span>
            ) : null}
            <span className="text-xs text-muted-foreground">共 {customer.licenseCount} 份授权</span>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/customers">
                <ArrowLeft className="size-3.5" /> 返回列表
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} /> 刷新
            </Button>
            {canWrite ? (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="size-3.5" /> 编辑资料
              </Button>
            ) : null}
            {canIssue ? (
              <Button size="sm" asChild>
                <Link href={`/app/licenses?customerId=${customer.id}&issue=1`}>
                  <Plus className="size-3.5" /> 签发授权
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <Section title="客户档案" description="客户信息用于授权签发时的归属记录，不参与校验逻辑。">
        <InfoGrid
          columns={3}
          items={[
            { label: "联系人姓名", value: customer.name },
            { label: "联系邮箱", value: customer.email ?? "—", hint: customer.email ? undefined : "未填写邮箱，无法接收到期提醒" },
            { label: "联系电话", value: customer.phone ?? "—", mono: true },
            { label: "公司名称", value: customer.companyName ?? "—" },
            { label: "客户编码", value: customer.customerCode ?? "—", mono: true },
            { label: "授权数量", value: `${customer.licenseCount} 份` },
            { label: "创建时间", value: formatDateTime(customer.createdAt) },
            { label: "最近更新", value: formatDateTime(customer.updatedAt) },
            { label: "客户 ID", value: <span className="font-mono text-[11px]">{customer.id}</span> },
          ]}
        />
      </Section>

      <Section
        title="该客户的授权"
        description="点行进入授权详情：设备、功能权限、续费记录都在那里。"
        actions={
          <Button variant="ghost" size="xs" asChild>
            <Link href={`/app/licenses?customerId=${customer.id}`}>
              在授权列表筛选 <ArrowUpRight className="size-3" />
            </Link>
          </Button>
        }
      >
        <div className="-m-4">
          <DataTable
            columns={licenseColumns}
            rows={licenses}
            rowKey={(row) => row.id}
            // 与授权列表一致：整行可点进详情。
            onRowClick={(row) => router.push(`/app/licenses/${row.id}`)}
            caption="该客户的授权列表"
            empty={
              <EmptyState
                title="该客户还没有授权"
                description="签发第一份授权后，这里会显示它的周期与状态。"
                icon={<Ticket className="size-5" />}
                action={
                  canIssue ? (
                    <Button size="sm" asChild>
                      <Link href={`/app/licenses?customerId=${customer.id}&issue=1`}>
                        <Plus className="size-3.5" /> 签发授权
                      </Link>
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </div>
      </Section>

      <Section title="备注" description="内部备注，不会出现在客户端或导出文件中。">
        {customer.notes ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{customer.notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">暂无备注。</p>
        )}
      </Section>

      <Section title="身份绑定" description="第三方登录 / 单点身份与该客户的关联记录。">
        <div className="-m-4">
          <DataTable
            columns={identityColumns}
            rows={identities}
            rowKey={(row) => row.id}
            caption="客户身份绑定"
            empty={
              <EmptyState
                title="没有绑定身份"
                description="该客户目前只用兑换码识别，未接入第三方身份。"
                icon={<UserRound className="size-5" />}
              />
            }
          />
        </div>
      </Section>

      {canWrite ? (
        <EditCustomerDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          customer={{
            id: customer.id,
            customerCode: customer.customerCode,
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            companyName: customer.companyName,
            notes: customer.notes,
            status: customer.status,
          }}
          onSaved={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export default function CustomerDetailPage() {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <CustomerDetailInner />
    </Suspense>
  );
}
