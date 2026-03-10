"use client";

import { useCallback, useEffect, useState } from "react";

const API_KEYS_STORAGE_KEY = "tradeict-earner-api-keys";

function getApiKeysFromStorage(): {
  binanceApiKey: string;
  binanceApiSecret: string;
  bybitApiKey: string;
  bybitApiSecret: string;
} {
  if (typeof window === "undefined")
    return { binanceApiKey: "", binanceApiSecret: "", bybitApiKey: "", bybitApiSecret: "" };
  try {
    const raw = localStorage.getItem(API_KEYS_STORAGE_KEY);
    if (!raw) return { binanceApiKey: "", binanceApiSecret: "", bybitApiKey: "", bybitApiSecret: "" };
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      binanceApiKey: typeof p.binanceApiKey === "string" ? p.binanceApiKey : "",
      binanceApiSecret: typeof p.binanceApiSecret === "string" ? p.binanceApiSecret : "",
      bybitApiKey: typeof p.bybitApiKey === "string" ? p.bybitApiKey : "",
      bybitApiSecret: typeof p.bybitApiSecret === "string" ? p.bybitApiSecret : "",
    };
  } catch {
    return { binanceApiKey: "", binanceApiSecret: "", bybitApiKey: "", bybitApiSecret: "" };
  }
}

export default function FundsPage() {
  const [binanceBalance, setBinanceBalance] = useState<number | null>(null);
  const [bybitBalance, setBybitBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBalances = useCallback(() => {
    const keys = getApiKeysFromStorage();
    if (!keys.binanceApiKey || !keys.binanceApiSecret || !keys.bybitApiKey || !keys.bybitApiSecret) {
      setBinanceBalance(null);
      setBybitBalance(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch("/api/settings/balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(keys),
    })
      .then((r) => r.json())
      .then((data: { binance?: number; bybit?: number; error?: string }) => {
        if (data.error) {
          setBinanceBalance(null);
          setBybitBalance(null);
        } else {
          setBinanceBalance(typeof data.binance === "number" ? data.binance : null);
          setBybitBalance(typeof data.bybit === "number" ? data.bybit : null);
        }
      })
      .catch(() => {
        setBinanceBalance(null);
        setBybitBalance(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  const binance = binanceBalance ?? 0;
  const bybit = bybitBalance ?? 0;
  const combined = binance + bybit;
  const diff = Math.abs(binance - bybit);
  const transferAmount = diff / 2;
  const fromBinanceToBybit = binance > bybit;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Funds</h1>
        <p className="text-slate-400 text-sm mt-1">Balance overview and rebalancing</p>
      </div>

      {/* Balance Overview */}
      <div className="glass-panel p-6 md:p-8">
        <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3 mb-6">Balance Overview</h2>
        {loading ? (
          <p className="text-slate-500">Loading balances…</p>
        ) : binanceBalance === null && bybitBalance === null ? (
          <p className="text-slate-500">Save API keys in Settings to see balances.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
            <div className="rounded-xl border border-white/[0.1] bg-white/[0.04] p-5 md:p-6">
              <p className="text-slate-400 text-sm font-medium uppercase tracking-wider">Binance</p>
              <p className="text-2xl md:text-3xl font-bold text-white mt-2">
                ${binance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-slate-500 text-xs mt-1">Available USDT</p>
            </div>
            <div className="rounded-xl border border-white/[0.1] bg-white/[0.04] p-5 md:p-6">
              <p className="text-slate-400 text-sm font-medium uppercase tracking-wider">Bybit</p>
              <p className="text-2xl md:text-3xl font-bold text-white mt-2">
                ${bybit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-slate-500 text-xs mt-1">Available USDT</p>
            </div>
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-5 md:p-6">
              <p className="text-slate-400 text-sm font-medium uppercase tracking-wider">Combined</p>
              <p className="text-2xl md:text-3xl font-bold text-white mt-2">
                ${combined.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-slate-500 text-xs mt-1">Total USDT</p>
            </div>
          </div>
        )}
      </div>

      {/* Rebalancing */}
      <div className="glass-panel p-6 md:p-8">
        <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3 mb-4">Rebalancing</h2>
        <p className="text-slate-400 text-sm mb-4">Transfer suggestion to equalize balances across exchanges.</p>
        {loading || (binanceBalance === null && bybitBalance === null) ? (
          <p className="text-slate-500 text-sm">—</p>
        ) : transferAmount < 0.01 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-emerald-200">
            Balances are equal. No transfer needed.
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-4">
            <p className="text-white font-medium">
              Transfer{" "}
              <span className="text-blue-300 font-semibold">
                {transferAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
              </span>{" "}
              from {fromBinanceToBybit ? "Binance" : "Bybit"} to {fromBinanceToBybit ? "Bybit" : "Binance"} to equalize.
            </p>
            <p className="text-slate-500 text-sm mt-1">
              After transfer: each exchange would have{" "}
              ${(combined / 2).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT.
            </p>
          </div>
        )}
      </div>

      {/* Refresh hint */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={fetchBalances}
          disabled={loading}
          className="glass-button px-4 py-2 rounded-xl text-sm font-medium text-slate-300 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh balances"}
        </button>
      </div>
    </div>
  );
}
