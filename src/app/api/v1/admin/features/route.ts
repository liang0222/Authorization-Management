import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withAdmin } from "@/lib/auth/guard";
import { cursorFields, asEnum, okResponse, readListQuery } from "@/lib/http/api";
import type { Prisma } from "@/generated/prisma/client";

/**
 * 跨产品的功能权限总览（规格 2.3-B、15.4“业务管理 / 功能权限”）。
 *
 * 设计决策：
 * - 功能定义按产品维度唯一（product_features 唯一键 product_id + code），
 *   所以引用计数必须以 (product_id, code) 为键，不能只用 code，否则会串到其他产品。
 * - 套餐/授权的引用数量用两次 groupBy 一次算完当前页所有功能，避免逐行 count 造成 N+1。
 */

const FEATURE_STATUSES = ["active", "disabled", "archived"] as const;

export async function GET(req: NextRequest) {
  return withAdmin(req, "feature:read", async ({ session, requestId }) => {
    const organizationId = session.organization.id;
    const url = new URL(req.url);
    const query = readListQuery(url);
    const productId = url.searchParams.get("productId")?.trim() || undefined;
    const status = asEnum(url.searchParams.get("status"), FEATURE_STATUSES);

    const where: Prisma.product_featuresWhereInput = {
      organization_id: organizationId,
      ...(productId ? { product_id: productId } : {}),
      ...(status ? { status } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { code: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.product_features.findMany({
        where,
        orderBy: [{ product_id: "asc" }, { code: "asc" }],
        skip: query.skip,
        take: query.pageSize,
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          value_type: true,
          default_value: true,
          status: true,
          product_id: true,
          created_at: true,
          products: { select: { id: true, name: true, code: true } },
        },
      }),
      prisma.product_features.count({ where }),
    ]);

    // 当前页涉及的产品/功能编码：groupBy 一次拿到全部引用计数
    const productIds = Array.from(new Set(rows.map((row) => row.product_id)));
    const featureCodes = Array.from(new Set(rows.map((row) => row.code)));
    const scope = {
      organization_id: organizationId,
      product_id: { in: productIds },
      feature_code: { in: featureCodes },
    };
    const [planCounts, licenseCounts] = await Promise.all([
      prisma.plan_features.groupBy({
        by: ["product_id", "feature_code"],
        where: scope,
        _count: { _all: true },
      }),
      prisma.license_features.groupBy({
        by: ["product_id", "feature_code"],
        where: scope,
        _count: { _all: true },
      }),
    ]);

    const countKey = (productIdValue: string, code: string) => `${productIdValue}:${code}`;
    const planMap = new Map(
      planCounts.map((row) => [countKey(row.product_id, row.feature_code), row._count._all]),
    );
    const licenseMap = new Map(
      licenseCounts.map((row) => [countKey(row.product_id, row.feature_code), row._count._all]),
    );

    return okResponse(
      {
        items: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          valueType: row.value_type,
          defaultValue: row.default_value,
          status: row.status,
          product: { id: row.products.id, name: row.products.name, code: row.products.code },
          /** 引用该功能的套餐数量（plan_features） */
          planCount: planMap.get(countKey(row.product_id, row.code)) ?? 0,
          /** 引用该功能的授权数量（license_features） */
          licenseCount: licenseMap.get(countKey(row.product_id, row.code)) ?? 0,
          createdAt: row.created_at.toISOString(),
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
        ...cursorFields(rows.length, total, query),
      },
      requestId,
    );
  });
}
