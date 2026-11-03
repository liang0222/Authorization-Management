"use client";

/** 浏览器端统一 API 客户端：自动带 CSRF、统一错误结构、401 可被上层捕获。 */

export interface ApiSuccess<T> {
  ok: true;
  code: "OK";
  message: string;
  request_id: string;
  server_time: string;
  data: T;
}

export interface ApiFailure {
  ok: false;
  code: string;
  message: string;
  request_id: string;
  server_time: string;
  details?: { fieldErrors?: Record<string, string> } & Record<string, unknown>;
}

export class ClientApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiFailure["details"];
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: ApiFailure["details"], requestId?: string) {
    super(message);
    this.name = "ClientApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  get fieldErrors(): Record<string, string> {
    return this.details?.fieldErrors ?? {};
  }
}

export function readCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)lic_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** 下载场景需要原始 Response */
  raw?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = readCsrfToken();

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ClientApiError(0, "NETWORK_ERROR", "网络连接失败，请检查网络后重试");
  }

  if (options.raw) return response as unknown as T;

  let payload: ApiSuccess<T> | ApiFailure | null = null;
  try {
    payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  } catch {
    throw new ClientApiError(response.status, "INVALID_RESPONSE", "服务端返回了无法解析的响应");
  }

  if (!payload || payload.ok !== true) {
    const failure = payload as ApiFailure | null;
    throw new ClientApiError(
      response.status,
      failure?.code ?? "UNKNOWN_ERROR",
      failure?.message ?? "请求失败，请稍后重试",
      failure?.details,
      failure?.request_id,
    );
  }
  return payload.data;
}

export function buildQuery(
  params: Record<string, string | number | boolean | undefined | null | string[]>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      value.forEach((item) => search.append(key, item));
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ClientApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生未知错误";
}
