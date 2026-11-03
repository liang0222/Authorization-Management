import type { EffectiveState, LicenseAdminStatus } from "@/lib/domain/effective-status";

export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface LicenseRow {
  id: string;
  adminStatus: LicenseAdminStatus;
  effective: EffectiveState;
  product: { id: string; name: string; code: string; type: string };
  customer: { id: string; name: string; email: string | null };
  duration: { unit: "day" | "month" | "lifetime"; value: number };
  startsAt: string | null;
  expiresAt: string | null;
  activationDeadlineAt: string | null;
  maxDevices: number;
  activeDevices: number;
  activationCount: number;
  maxActivationCount: number | null;
  keyMask: string | null;
  createdAt: string;
  timezone: string;
}

export interface Lookups {
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

export interface ProductRow {
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
  counts: { features: number; licenses: number; credentials: number; plans: number; activeDevices: number };
}

export interface CustomerRow {
  id: string;
  customerCode: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  status: string;
  createdAt: string;
  counts: { licenses: number; activeLicenses: number; identities: number };
}

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  duration: { unit: "day" | "month" | "lifetime"; value: number };
  startPolicy: string;
  activationDeadlineDays: number | null;
  maxDevices: number;
  maxActivationCount: number | null;
  maxSubjects: number | null;
  refundActivationOnRelease: boolean;
  offlineAllowed: boolean;
  offlineGraceSeconds: number;
  defaultFeatures: Record<string, unknown>;
  product: { id: string; name: string; code: string };
  createdAt: string;
  counts: { features: number; issued: number };
}
