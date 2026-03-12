"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useApiKeys } from "@/contexts/ApiKeysContext";

const SETTINGS_STORAGE_KEY = "tradeict-earner-settings";

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

function maskValue(val: string): string {
  if (!val || val.length === 0) return "";
  if (val.length <= 4) return "************";
  return "************" + val.slice(-4);
}

export interface SettingsState {
  autoTrade: boolean;
  autoExit: boolean;
  capitalPercent: number;
  maxTradeSlot: number;
  leverage: number;
  stoplossPercent: number;
  targetPercent: number;
  slippagePercent: number;
  feesPercent: number;
}

const DEFAULT_SETTINGS: SettingsState = {
  autoTrade: false,
  autoExit: false,
  capitalPercent: 10,
  maxTradeSlot: 5,
  leverage: 3,
  stoplossPercent: 2,
  targetPercent: 1.5,
  slippagePercent: 0.05,
  feesPercent: 0.1,
};

function loadSettings(): SettingsState {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return {
      autoTrade: typeof parsed.autoTrade === "boolean" ? parsed.autoTrade : DEFAULT_SETTINGS.autoTrade,
      autoExit: typeof parsed.autoExit === "boolean" ? parsed.autoExit : DEFAULT_SETTINGS.autoExit,
      capitalPercent: typeof parsed.capitalPercent === "number" ? parsed.capitalPercent : DEFAULT_SETTINGS.capitalPercent,
      maxTradeSlot: typeof parsed.maxTradeSlot === "number" ? parsed.maxTradeSlot : DEFAULT_SETTINGS.maxTradeSlot,
      leverage: typeof parsed.leverage === "number" ? parsed.leverage : DEFAULT_SETTINGS.leverage,
      stoplossPercent: typeof parsed.stoplossPercent === "number" ? parsed.stoplossPercent : DEFAULT_SETTINGS.stoplossPercent,
      targetPercent: typeof parsed.targetPercent === "number" ? parsed.targetPercent : DEFAULT_SETTINGS.targetPercent,
      slippagePercent: typeof parsed.slippagePercent === "number" ? parsed.slippagePercent : DEFAULT_SETTINGS.slippagePercent,
      feesPercent: typeof parsed.feesPercent === "number" ? parsed.feesPercent : DEFAULT_SETTINGS.feesPercent,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: SettingsState): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

type ApiKeyField = "binanceApiKey" | "binanceApiSecret" | "bybitApiKey" | "bybitApiSecret";

export default function SettingsPage() {
  const router = useRouter();
  const { apiKeys: contextApiKeys, refreshApiKeys, loading: profileLoading } = useApiKeys();
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [apiKeys, setApiKeys] = useState<ApiKeysState>(DEFAULT_API_KEYS);
  const [hydrated, setHydrated] = useState(false);
  const [focusedField, setFocusedField] = useState<ApiKeyField | null>(null);
  const [editValue, setEditValue] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [testing, setTesting] = useState<"binance" | "bybit" | null>(null);
  const [savingKeys, setSavingKeys] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSettings(loadSettings());
    setHydrated(true);
  }, []);

  // Sync local API key inputs when profile has finished loading from the server (avoids overwriting with empty before fetch completes).
  useEffect(() => {
    if (profileLoading) return;
    setApiKeys({
      binanceApiKey: contextApiKeys.binanceApiKey ?? "",
      binanceApiSecret: contextApiKeys.binanceApiSecret ?? "",
      bybitApiKey: contextApiKeys.bybitApiKey ?? "",
      bybitApiSecret: contextApiKeys.bybitApiSecret ?? "",
    });
  }, [profileLoading, contextApiKeys.binanceApiKey, contextApiKeys.binanceApiSecret, contextApiKeys.bybitApiKey, contextApiKeys.bybitApiSecret]);

  useEffect(() => {
    if (!hydrated) return;
    saveSettings(settings);

    // Sync settings with the backend WS server
    try {
      const wsUrl = `ws://${window.location.hostname}:8080`;
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            action: "set_auto_exit_settings",
            payload: {
              autoTrade: settings.autoTrade,
              autoExit: settings.autoExit,
              stoplossPercent: settings.stoplossPercent,
              targetPercent: settings.targetPercent,
              slippagePercent: settings.slippagePercent,
              feesPercent: settings.feesPercent,
              leverage: settings.leverage,
              capitalPercent: settings.capitalPercent,
              maxTradeSlot: settings.maxTradeSlot,
            },
          })
        );
        setTimeout(() => ws.close(), 500);
      };
      ws.onerror = (err) => console.error("WS sync error", err);
    } catch (e) {
      console.error("Failed to sync settings with WS backend", e);
    }
  }, [settings, hydrated]);


  const showToast = useCallback((message: string, type: "success" | "error") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  const saveApiKeysToProfile = useCallback(async () => {
    setSavingKeys(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKeys: {
            binanceApiKey: apiKeys.binanceApiKey.trim(),
            binanceApiSecret: apiKeys.binanceApiSecret.trim(),
            bybitApiKey: apiKeys.bybitApiKey.trim(),
            bybitApiSecret: apiKeys.bybitApiSecret.trim(),
          },
        }),
      });
      if (res.ok) {
        await refreshApiKeys();
        showToast("API keys saved and synced across devices", "success");
      } else {
        const data = await res.json().catch(() => ({}));
        showToast((data as { error?: string }).error ?? "Failed to save API keys", "error");
      }
    } catch {
      showToast("Failed to save API keys", "error");
    } finally {
      setSavingKeys(false);
    }
  }, [apiKeys, refreshApiKeys, showToast]);

  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateApiKey = (key: ApiKeyField, value: string) => {
    setApiKeys((prev) => ({ ...prev, [key]: value }));
  };

  const resetToDefaults = () => setSettings(DEFAULT_SETTINGS);

  const getDisplayValue = (key: ApiKeyField) => {
    const val = apiKeys[key];
    if (focusedField === key) return editValue;
    return val?.trim() ? maskValue(val) : "";
  };

  const handleKeyFocus = (key: ApiKeyField) => {
    setFocusedField(key);
    setEditValue(apiKeys[key] || "");
  };

  const handleKeyBlur = (key: ApiKeyField) => {
    updateApiKey(key, focusedField === key ? editValue : apiKeys[key]);
    setFocusedField(null);
    setEditValue("");
  };

  const handleKeyChange = (key: ApiKeyField, value: string) => {
    setEditValue(value);
    if (focusedField === key) updateApiKey(key, value);
  };

  const testConnection = async (exchange: "binance" | "bybit") => {
    const key = exchange === "binance" ? apiKeys.binanceApiKey : apiKeys.bybitApiKey;
    const secret = exchange === "binance" ? apiKeys.binanceApiSecret : apiKeys.bybitApiSecret;
    if (!key?.trim() || !secret?.trim()) {
      showToast("Enter API key and secret first", "error");
      return;
    }
    setTesting(exchange);
    try {
      const res = await fetch("/api/settings/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange, apiKey: key, apiSecret: secret }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        showToast("API keys are valid", "success");
      } else {
        showToast(data.error ?? "Connection failed", "error");
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Connection failed", "error");
    } finally {
      setTesting(null);
    }
  };

  const hasBinanceKeys = !!(apiKeys.binanceApiKey?.trim() && apiKeys.binanceApiSecret?.trim());
  const hasBybitKeys = !!(apiKeys.bybitApiKey?.trim() && apiKeys.bybitApiSecret?.trim());

  const handleLogout = useCallback(async () => {
    try {
      await signOut({ redirect: false });
      router.push("/login");
      router.refresh();
    } catch {
      router.push("/login");
    }
  }, [router]);

  const inputClass =
    "w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50";

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Settings</h1>
          <p className="text-slate-400 text-sm mt-1">Bot configuration — API keys sync across devices when logged in</p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="shrink-0 px-4 py-2.5 rounded-xl text-sm font-medium text-red-300 border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 transition-colors"
        >
          Logout
        </button>
      </div>

      <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
        {/* Toggles */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Toggles</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            <div className="flex items-center justify-between rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3">
              <label className="text-sm font-medium text-slate-300">Auto Trade</label>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoTrade}
                onClick={() => update("autoTrade", !settings.autoTrade)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
                  settings.autoTrade
                    ? "border-blue-500/50 bg-blue-500/30"
                    : "border-white/[0.2] bg-white/[0.08]"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                    settings.autoTrade ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3">
              <label className="text-sm font-medium text-slate-300">Auto Exit</label>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoExit}
                onClick={() => update("autoExit", !settings.autoExit)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
                  settings.autoExit
                    ? "border-blue-500/50 bg-blue-500/30"
                    : "border-white/[0.2] bg-white/[0.08]"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                    settings.autoExit ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* Risk inputs */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Risk</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Capital % per trade</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={settings.capitalPercent}
                onChange={(e) => update("capitalPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Max trade slot</label>
              <input
                type="number"
                min={1}
                max={50}
                value={settings.maxTradeSlot}
                onChange={(e) => update("maxTradeSlot", Number(e.target.value) || 1)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Leverage</label>
              <input
                type="number"
                min={1}
                max={125}
                value={settings.leverage}
                onChange={(e) => update("leverage", Number(e.target.value) || 1)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Stoploss %</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={settings.stoplossPercent}
                onChange={(e) => update("stoplossPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Target %</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={settings.targetPercent}
                onChange={(e) => update("targetPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Slippage %</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={settings.slippagePercent}
                onChange={(e) => update("slippagePercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Fees % (Total)</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={settings.feesPercent}
                onChange={(e) => update("feesPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Exchange API keys */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Exchange API keys</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-3 rounded-xl border border-white/[0.08] p-4 bg-white/[0.02]">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-slate-300">Binance</h3>
                {hasBinanceKeys && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Saved
                  </span>
                )}
              </div>
              <input
                type="password"
                placeholder="API key"
                value={getDisplayValue("binanceApiKey")}
                onFocus={() => handleKeyFocus("binanceApiKey")}
                onBlur={() => handleKeyBlur("binanceApiKey")}
                onChange={(e) => handleKeyChange("binanceApiKey", e.target.value)}
                className={inputClass}
                autoComplete="off"
              />
              <input
                type="password"
                placeholder="API secret"
                value={getDisplayValue("binanceApiSecret")}
                onFocus={() => handleKeyFocus("binanceApiSecret")}
                onBlur={() => handleKeyBlur("binanceApiSecret")}
                onChange={(e) => handleKeyChange("binanceApiSecret", e.target.value)}
                className={inputClass}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => testConnection("binance")}
                disabled={!hasBinanceKeys || testing !== null}
                className="w-full glass-button px-4 py-3 rounded-xl text-sm font-medium text-slate-200 border border-white/[0.12] hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-h-[44px]"
              >
                {testing === "binance" ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Checking API…
                  </>
                ) : (
                  "Test connection"
                )}
              </button>
            </div>
            <div className="space-y-3 rounded-xl border border-white/[0.08] p-4 bg-white/[0.02]">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-slate-300">Bybit</h3>
                {hasBybitKeys && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Saved
                  </span>
                )}
              </div>
              <input
                type="password"
                placeholder="API key"
                value={getDisplayValue("bybitApiKey")}
                onFocus={() => handleKeyFocus("bybitApiKey")}
                onBlur={() => handleKeyBlur("bybitApiKey")}
                onChange={(e) => handleKeyChange("bybitApiKey", e.target.value)}
                className={inputClass}
                autoComplete="off"
              />
              <input
                type="password"
                placeholder="API secret"
                value={getDisplayValue("bybitApiSecret")}
                onFocus={() => handleKeyFocus("bybitApiSecret")}
                onBlur={() => handleKeyBlur("bybitApiSecret")}
                onChange={(e) => handleKeyChange("bybitApiSecret", e.target.value)}
                className={inputClass}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => testConnection("bybit")}
                disabled={!hasBybitKeys || testing !== null}
                className="w-full glass-button px-4 py-3 rounded-xl text-sm font-medium text-slate-200 border border-white/[0.12] hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-h-[44px]"
              >
                {testing === "bybit" ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden>
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Checking API…
                  </>
                ) : (
                  "Test connection"
                )}
              </button>
            </div>
          </div>
          <div className="pt-2">
            <button
              type="button"
              onClick={saveApiKeysToProfile}
              disabled={savingKeys}
              className="glass-button px-5 py-2.5 rounded-xl text-sm font-medium text-white border border-white/[0.12] disabled:opacity-50"
            >
              {savingKeys ? "Saving…" : "Save API Keys"}
            </button>
          </div>
        </div>

        {/* Legacy risk (optional) */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Risk management</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Max position size (USDT)</label>
              <input type="number" placeholder="1000" min={0} className={inputClass} />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Min spread (%) to trade</label>
              <input type="number" placeholder="0.05" min={0} step={0.01} className={inputClass} />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Funding diff threshold (%)</label>
              <input type="number" placeholder="0.02" min={0} step={0.01} className={inputClass} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className="glass-button px-6 py-3 rounded-xl text-sm font-medium text-white accent-border"
          >
            Save settings
          </button>
          <button
            type="button"
            onClick={resetToDefaults}
            className="glass-button px-6 py-3 rounded-xl text-sm font-medium text-slate-400 border-white/[0.08]"
          >
            Reset to defaults
          </button>
        </div>
      </form>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl border shadow-lg max-w-sm ${
            toast.type === "success"
              ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-200"
              : "bg-red-500/20 border-red-500/40 text-red-200"
          }`}
          role="alert"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
