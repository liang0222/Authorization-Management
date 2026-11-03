"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, ClientApiError } from "@/lib/client/api";

export interface NavItem {
  label: string;
  href: string;
  permission: string;
  matchPrefixes?: string[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface SessionPayload {
  user: { id: string; email: string; displayName: string; mfaEnabled: boolean };
  organization: { id: string; name: string; slug: string; timezone: string; settings: Record<string, unknown> };
  role: { id: string; code: string; name: string };
  permissions: string[];
  navGroups: NavGroup[];
  expiresAt: string;
}

interface SessionState {
  status: "loading" | "ready" | "unauthenticated";
  session: SessionPayload | null;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await apiRequest<SessionPayload>("/api/v1/auth/session");
      setSession(payload);
      setStatus("ready");
      setError(null);
    } catch (cause) {
      if (cause instanceof ClientApiError && cause.status === 401) {
        setSession(null);
        setStatus("unauthenticated");
        setError(null);
        return;
      }
      setError(cause instanceof Error ? cause.message : "加载会话失败");
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    try {
      await apiRequest("/api/v1/auth/logout", { method: "POST" });
    } finally {
      setSession(null);
      setStatus("unauthenticated");
      router.replace("/login");
      router.refresh();
    }
  }, [router]);

  const hasPermission = useCallback(
    (code: string) => Boolean(session?.permissions.includes(code)),
    [session],
  );

  const value = useMemo<SessionState>(
    () => ({ status, session, error, refresh: load, logout, hasPermission }),
    [status, session, error, load, logout, hasPermission],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession 必须在 SessionProvider 内使用");
  return context;
}
