import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { okResponse } from "@/lib/http/api";

/** 表单下拉数据：签发授权/创建套餐/创建凭证共用一次请求，避免页面重复拉取。 */
export async function GET(req: NextRequest) {
  return withAdmin(req, null, async ({ session, requestId }) => {
    const organizationId = session.organization.id;
    const [products, customers, plans, features] = await Promise.all([
      prisma.products.findMany({
        where: { organization_id: organizationId },
        select: { id: true, code: true, name: true, product_type: true, status: true },
        orderBy: { name: "asc" },
      }),
      prisma.customers.findMany({
        where: { organization_id: organizationId, status: "active" },
        select: { id: true, name: true, email: true, customer_code: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
      prisma.plans.findMany({
        where: { organization_id: organizationId, status: "active" },
        select: {
          id: true,
          code: true,
          name: true,
          product_id: true,
          duration_unit: true,
          duration_value: true,
          max_devices: true,
          max_activation_count: true,
          max_subjects: true,
          start_policy: true,
          activation_deadline_days: true,
          offline_allowed: true,
          offline_grace_seconds: true,
          refund_activation_on_release: true,
          default_features: true,
        },
        orderBy: { name: "asc" },
      }),
      prisma.product_features.findMany({
        where: { organization_id: organizationId, status: "active" },
        select: { id: true, product_id: true, code: true, name: true, value_type: true, default_value: true },
        orderBy: { code: "asc" },
      }),
    ]);

    return okResponse(
      {
        products: products.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          type: row.product_type,
          status: row.status,
        })),
        customers,
        plans: plans.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          productId: row.product_id,
          duration: { unit: row.duration_unit, value: row.duration_value },
          maxDevices: row.max_devices,
          maxActivationCount: row.max_activation_count,
          maxSubjects: row.max_subjects,
          startPolicy: row.start_policy,
          activationDeadlineDays: row.activation_deadline_days,
          offlineAllowed: row.offline_allowed,
          offlineGraceSeconds: row.offline_grace_seconds,
          refundActivationOnRelease: row.refund_activation_on_release,
          defaultFeatures: row.default_features,
        })),
        features: features.map((row) => ({
          id: row.id,
          productId: row.product_id,
          code: row.code,
          name: row.name,
          valueType: row.value_type,
          defaultValue: row.default_value,
        })),
      },
      requestId,
    );
  });
}
