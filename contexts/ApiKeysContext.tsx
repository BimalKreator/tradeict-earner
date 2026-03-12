"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useSession } from "next-auth/react";

export interface ApiKeysState {
  binanceApiKey: string;
  binanceApiSecret: string;
  bybitApiKey: string;
  bybitApiSecret: string;
}

const DEFAULT_API_KEYS: ApiKeysState = {
  binanceApiKey: "",
  binanceApiSecret: "",
  bybitApiKey: "",
  bybitApiSecret: "",
};

type ApiKeysContextValue = {
  apiKeys: ApiKeysState;
  refreshApiKeys: () => Promise<void>;
  loading: boolean;
};

const ApiKeysContext = createContext<ApiKeysContextValue>({
  apiKeys: DEFAULT_API_KEYS,
  refreshApiKeys: async () => {},
  loading: true,
});

export function ApiKeysProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const [apiKeys, setApiKeys] = useState<ApiKeysState>(DEFAULT_API_KEYS);
  const [loading, setLoading] = useState(true);

  const refreshApiKeys = useCallback(async () => {
    if (status !== "authenticated") {
      setApiKeys(DEFAULT_API_KEYS);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/profile");
      if (res.ok) {
        const data = await res.json();
        setApiKeys({
          binanceApiKey: typeof data.apiKeys?.binanceApiKey === "string" ? data.apiKeys.binanceApiKey : "",
          binanceApiSecret: typeof data.apiKeys?.binanceApiSecret === "string" ? data.apiKeys.binanceApiSecret : "",
          bybitApiKey: typeof data.apiKeys?.bybitApiKey === "string" ? data.apiKeys.bybitApiKey : "",
          bybitApiSecret: typeof data.apiKeys?.bybitApiSecret === "string" ? data.apiKeys.bybitApiSecret : "",
        });
      } else {
        setApiKeys(DEFAULT_API_KEYS);
      }
    } catch {
      setApiKeys(DEFAULT_API_KEYS);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (status === "unauthenticated") {
      setApiKeys(DEFAULT_API_KEYS);
      setLoading(false);
      return;
    }
    if (status === "authenticated") {
      refreshApiKeys();
    }
  }, [status, refreshApiKeys]);

  return (
    <ApiKeysContext.Provider value={{ apiKeys, refreshApiKeys, loading }}>
      {children}
    </ApiKeysContext.Provider>
  );
}

export function useApiKeys(): ApiKeysContextValue {
  const ctx = useContext(ApiKeysContext);
  if (!ctx) {
    return {
      apiKeys: DEFAULT_API_KEYS,
      refreshApiKeys: async () => {},
      loading: false,
    };
  }
  return ctx;
}
