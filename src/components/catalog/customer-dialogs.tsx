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
import { FormError, FormField } from "@/components/app/form-field";
import { apiRequest, ClientApiError, errorMessage } from "@/lib/client/api";

export interface CustomerDetail {
  id: string;
  customerCode: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  notes: string | null;
  status: string;
}

const EMPTY = {
  name: "",
  customerCode: "",
  email: "",
  phone: "",
  companyName: "",
  notes: "",
};

function readErrors(err: unknown): Record<string, string> {
  return err instanceof ClientApiError ? err.fieldErrors : {};
}

/** 新建客户：编码留空时由服务端生成，方便与外部 CRM 编号对齐。 */
export function CreateCustomerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) return;
    setForm(EMPTY);
    setError(null);
    setFieldErrors({});
  }, [open]);

  const patch = (next: Partial<typeof EMPTY>) => setForm((prev) => ({ ...prev, ...next }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await apiRequest<{ id: string }>("/api/v1/admin/customers", {
        method: "POST",
        body: {
          name: form.name.trim(),
          customerCode: form.customerCode.trim() || undefined,
          email: form.email.trim() || undefined,
          phone: form.phone.trim() || undefined,
          companyName: form.companyName.trim() || undefined,
          notes: form.notes.trim() || undefined,
        },
      });
      toast.success("客户已创建", { description: "现在可以为这个客户签发授权。" });
      onCreated(result.id);
      onOpenChange(false);
    } catch (err) {
      setFieldErrors(readErrors(err));
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>新建客户</DialogTitle>
          <DialogDescription>客户是授权的持有方，一个客户可以持有多份不同产品的授权。</DialogDescription>
        </DialogHeader>
        <form id="create-customer-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="客户名称" htmlFor="customer-name" required error={fieldErrors.name}>
              <Input id="customer-name" value={form.name} onChange={(event) => patch({ name: event.target.value })} placeholder="杭州云枢科技" required />
            </FormField>
            <FormField label="客户编号" htmlFor="customer-code" error={fieldErrors.customerCode} hint="留空自动生成，可填外部 CRM 编号。">
              <Input
                id="customer-code"
                value={form.customerCode}
                onChange={(event) => patch({ customerCode: event.target.value })}
                className="font-mono text-xs"
                placeholder="CUS-2026-018"
              />
            </FormField>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="联系邮箱" htmlFor="customer-email" error={fieldErrors.email}>
              <Input
                id="customer-email"
                type="email"
                value={form.email}
                onChange={(event) => patch({ email: event.target.value })}
                placeholder="ops@example.com"
              />
            </FormField>
            <FormField label="联系电话" htmlFor="customer-phone" error={fieldErrors.phone}>
              <Input id="customer-phone" value={form.phone} onChange={(event) => patch({ phone: event.target.value })} placeholder="13800000000" />
            </FormField>
          </div>
          <FormField label="公司主体" htmlFor="customer-company" error={fieldErrors.companyName}>
            <Input id="customer-company" value={form.companyName} onChange={(event) => patch({ companyName: event.target.value })} placeholder="与合同签署主体保持一致" />
          </FormField>
          <FormField label="备注" htmlFor="customer-notes">
            <Textarea
              id="customer-notes"
              value={form.notes}
              onChange={(event) => patch({ notes: event.target.value })}
              rows={2}
              placeholder="销售渠道、合同编号等内部信息。"
            />
          </FormField>
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="create-customer-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            创建客户
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 编辑客户：状态字段在列表里用 DropdownMenu 切换，这里只改资料。 */
export function EditCustomerDialog({
  open,
  onOpenChange,
  customer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: CustomerDetail;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setForm({
      name: customer.name,
      customerCode: customer.customerCode ?? "",
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      companyName: customer.companyName ?? "",
      notes: customer.notes ?? "",
    });
    setError(null);
    setFieldErrors({});
  }, [open, customer]);

  const patch = (next: Partial<typeof EMPTY>) => setForm((prev) => ({ ...prev, ...next }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiRequest(`/api/v1/admin/customers/${customer.id}`, {
        method: "PATCH",
        body: {
          name: form.name.trim(),
          customerCode: form.customerCode.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          companyName: form.companyName.trim() || null,
          notes: form.notes.trim() || null,
        },
      });
      toast.success("客户资料已保存");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setFieldErrors(readErrors(err));
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>编辑客户</DialogTitle>
          <DialogDescription>客户编号用于对账，修改后历史授权记录仍保留原编号快照。</DialogDescription>
        </DialogHeader>
        <form id="edit-customer-form" className="space-y-3" onSubmit={submit}>
          <FormError message={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="客户名称" htmlFor="edit-customer-name" required error={fieldErrors.name}>
              <Input id="edit-customer-name" value={form.name} onChange={(event) => patch({ name: event.target.value })} required />
            </FormField>
            <FormField label="客户编号" htmlFor="edit-customer-code" error={fieldErrors.customerCode}>
              <Input
                id="edit-customer-code"
                value={form.customerCode}
                onChange={(event) => patch({ customerCode: event.target.value })}
                className="font-mono text-xs"
              />
            </FormField>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="联系邮箱" htmlFor="edit-customer-email" error={fieldErrors.email}>
              <Input id="edit-customer-email" type="email" value={form.email} onChange={(event) => patch({ email: event.target.value })} />
            </FormField>
            <FormField label="联系电话" htmlFor="edit-customer-phone" error={fieldErrors.phone}>
              <Input id="edit-customer-phone" value={form.phone} onChange={(event) => patch({ phone: event.target.value })} />
            </FormField>
          </div>
          <FormField label="公司主体" htmlFor="edit-customer-company" error={fieldErrors.companyName}>
            <Input id="edit-customer-company" value={form.companyName} onChange={(event) => patch({ companyName: event.target.value })} />
          </FormField>
          <FormField label="备注" htmlFor="edit-customer-notes">
            <Textarea id="edit-customer-notes" value={form.notes} onChange={(event) => patch({ notes: event.target.value })} rows={2} />
          </FormField>
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="edit-customer-form" size="sm" disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            保存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
