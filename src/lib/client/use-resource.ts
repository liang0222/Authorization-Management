"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, ClientApiError } from "@/lib/client/api";

export interface ResourceState<T> {
  data: T | null;
  error: ClientApiError | null;
  /** 首次加载（无任何数据） */
  isLoading: boolean;
  /** 后台刷新中（已有数据） */
  isRefreshing: boolean;
  refresh: () => void;
}

/**
 * 轻量数据获取：统一处理加载/错误/刷新与竞态（AbortController）。
 * 刷新时保留旧数据，避免表格整屏闪烁。
 */
export function useResource<T>(path: string | null): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ClientApiError | null>(null);
  const [isLoading, setIsLoading] = useState(path !== null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const hasDataRef = useRef(false);

  useEffect(() => {
    if (!path) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    if (hasDataRef.current) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    apiRequest<T>(path, { signal: controller.signal })
      .then((result) => {
        setData(result);
        hasDataRef.current = true;
        setError(null);
      })
      .catch((cause: unknown) => {
        if ((cause as Error).name === "AbortError") return;
        setError(cause instanceof ClientApiError ? cause : new ClientApiError(0, "UNKNOWN", "加载失败"));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsLoading(false);
        setIsRefreshing(false);
      });
    return () => controller.abort();
  }, [path, version]);

  const refresh = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);

  return { data, error, isLoading, isRefreshing, refresh };
}

/** 搜索框防抖：输入停止 300ms 后才更新查询参数。 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
