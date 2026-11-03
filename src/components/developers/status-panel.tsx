"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StatusPayload {
  window: string;
  total_requests: number;
  success_rate: number | null;
  p95_latency_ms: number | null;
  components: Array<{ name: string; status: string }>;
}

/**
 * 公开状态面板。刻意不用 useResource：/api/v1/status 不走管理后台会话，
 * 也不需要 CSRF，直接 fetch 更贴近真实使用者的调用方式。
 */
export function PublicStatusPanel() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/status", { signal, cache: "no-store" });
      const body = await res.json();
      if (!body.ok) throw new Error(body.message ?? "状态获取失败");
      setData(body.data as StatusPayload);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "状态获取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const operational = data?.components.every((item) => item.status === "operational") ?? false;

  return (
    <section className="mt-6 rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              error ? "bg-destructive" : operational ? "bg-emerald-500" : "bg-amber-500",
            )}
            aria-hidden
          />
          <span className="text-sm font-medium">
            {error ? "状态获取失败" : loading && !data ? "正在获取…" : operational ? "全部组件正常" : "部分组件降级"}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      {error ? (
        <p className="px-4 py-6 text-[13px] text-muted-foreground">{error}</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 divide-x divide-border">
            <div className="px-4 py-4">
              <dt className="text-[12px] text-muted-foreground">24h 请求量</dt>
              <dd className="tabular mt-1 text-xl font-semibold">
                {data ? data.total_requests.toLocaleString("zh-CN") : "—"}
              </dd>
            </div>
            <div className="px-4 py-4">
              <dt className="text-[12px] text-muted-foreground">成功率</dt>
              <dd className="tabular mt-1 text-xl font-semibold">
                {data?.success_rate == null ? "—" : `${(data.success_rate * 100).toFixed(1)}%`}
              </dd>
            </div>
            <div className="px-4 py-4">
              <dt className="text-[12px] text-muted-foreground">P95 延迟</dt>
              <dd className="tabular mt-1 text-xl font-semibold">
                {data?.p95_latency_ms == null ? "—" : `${data.p95_latency_ms} ms`}
              </dd>
            </div>
          </dl>
          <ul className="divide-y divide-border border-t border-border">
            {(data?.components ?? []).map((item) => (
              <li key={item.name} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                <span>{item.name}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                  正常
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
