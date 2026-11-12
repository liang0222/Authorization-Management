"use client";

import { useSyncExternalStore } from "react";

/**
 * 渲染期读“现在”会命中 react-hooks/purity：同一个输入可能渲染出不同结果，
 * React Compiler 也无法安全缓存。这里用 useSyncExternalStore 把时间当成
 * 外部可变源读取——服务端快照固定为 0，客户端每 60 秒推一次新快照。
 *
 * 只用于展示类判断（例如“是否已过期”），不参与任何授权/计费决策。
 */
let cachedNow = 0;

function getSnapshot(): number {
  if (cachedNow === 0) cachedNow = Date.now();
  return cachedNow;
}

function getServerSnapshot(): number {
  return 0;
}

function subscribe(onStoreChange: () => void): () => void {
  cachedNow = Date.now();
  const timer = window.setInterval(() => {
    cachedNow = Date.now();
    onStoreChange();
  }, 60_000);
  return () => window.clearInterval(timer);
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
