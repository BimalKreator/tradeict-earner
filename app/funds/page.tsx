"use client";

import { useCallback, useEffect, useState } from "react";

const API_KEYS_STORAGE_KEY = "tradeict-earner-api-keys";

interface BalanceMetrics {
  total: number;
  used: number;
  available: number;
}

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

function fmt(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function FundsPage() {
  const [binance, setBinance] = useState<BalanceMetrics | null>(null);
  const [bybit, setBybit] = useState<BalanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBalances = useCallback(() => {
    const keys = getApiKeysFromStorage();
    if (!keys.binanceApiKey || !keys.binanceApiSecret || !keys.bybitApiKey || !keys.bybitApiSecret) {
      setBinance(null);
      setBybit(null);
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
      .then((data: { binance?: BalanceMetrics; bybit?: BalanceMetrics; error?: string }) => {
        if (data.error) {
          setBinance(null);
          setBybit(null);
        } else {
          setBinance(
            data.binance && typeof data.binance.total === "number"
              ? {
                  total: data.binance.total,
                  used: data.binance.used ?? 0,
                  available: data.binance.available ?? 0,
                }
              : null
          );
          setBybit(
            data.bybit && typeof data.bybit.total === "number"
              ? {
                  total: data.bybit.total,
                  used: data.bybit.used ?? 0,
                  available: data.bybit.available ?? 0,
                }
              : null
          );
        }
      })
      .catch(() => {
        setBinance(null);
        setBybit(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  const hasData = binance !== null || bybit !== null;
  const bTotal = binance?.total ?? 0;
  const bUsed = binance?.used ?? 0;
  const bAvail = binance?.available ?? 0;
  const yTotal = bybit?.total ?? 0;
  const yUsed = bybit?.used ?? 0;
  const yAvail = bybit?.available ?? 0;
  const combTotal = bTotal + yTotal;
  const combUsed = bUsed + yUsed;
  const combAvail = bAvail + yAvail;

  const availDiff = Math.abs(bAvail - yAvail);
  const transferAmount = availDiff / 2;
  const fromBinanceToBybit = bAvail > yAvail;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Funds</h1>
        <p className="text-slate-400 text-sm mt-1">Balance overview and rebalancing</p>
      </div>

      {/* Balance table */}
      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Balance Overview</h2>
          <p className="text-slate-400 text-sm mt-0.5">Total, used margin, and available to trade (USDT)</p>
        </div>
        {loading ? (
          <div className="p-8 text-center text-slate-500">Loading balances…</div>
        ) : !hasData ? (
          <div className="p-8 text-center text-slate-500">Save API keys in Settings to see balances.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[400px]">
              <thead>
                <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                  <th className="p-4">Metric</th>
                  <th className="p-4 text-right">Binance</th>
                  <th className="p-4 text-right">Bybit</th>
                  <th className="p-4 text-right">Combined</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-white/[0.04]">
                  <td className="p-4 font-medium text-white">Total Balance</td>
                  <td className="p-4 text-right text-slate-200">{fmt(bTotal)}</td>
                  <td className="p-4 text-right text-slate-200">{fmt(yTotal)}</td>
                  <td className="p-4 text-right font-semibold text-white">{fmt(combTotal)}</td>
                </tr>
                <tr className="border-b border-white/[0.04]">
                  <td className="p-4 font-medium text-slate-300">Used Margin</td>
                  <td className="p-4 text-right text-slate-400">{fmt(bUsed)}</td>
                  <td className="p-4 text-right text-slate-400">{fmt(yUsed)}</td>
                  <td className="p-4 text-right text-slate-300">{fmt(combUsed)}</td>
                </tr>
                <tr className="border-b border-white/[0.04] last:border-0">
                  <td className="p-4 font-medium text-slate-300">Available Margin (To Trade)</td>
                  <td className="p-4 text-right text-emerald-300/90">{fmt(bAvail)}</td>
                  <td className="p-4 text-right text-emerald-300/90">{fmt(yAvail)}</td>
                  <td className="p-4 text-right font-medium text-emerald-300">{fmt(combAvail)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rebalancing Advice — based on Available Margin */}
      <div className="glass-panel p-6 md:p-8">
        <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3 mb-4">Rebalancing Advice</h2>
        <p className="text-slate-400 text-sm mb-4">
          Suggestion to equalize <strong className="text-slate-300">Available Margin</strong> across exchanges.
        </p>
        {loading || !hasData ? (
          <p className="text-slate-500 text-sm">—</p>
        ) : transferAmount < 0.01 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-emerald-200">
            Available margin is balanced. No transfer needed.
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-4">
            <p className="text-white font-medium">
              Transfer{" "}
              <span className="text-blue-300 font-semibold">{fmt(transferAmount)}</span> from{" "}
              {fromBinanceToBybit ? "Binance" : "Bybit"} to {fromBinanceToBybit ? "Bybit" : "Binance"} to equalize
              available margin.
            </p>
            <p className="text-slate-500 text-sm mt-1">
              After transfer, each exchange would have{" "}
              <span className="text-slate-300">{fmt(combAvail / 2)}</span> available to trade.
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={fetchBalances}
          disabled={loading}
          className="glass-button px-4 py-2 rounded-xl text-sm font-medium text-slate-300 disabled:opacity-50 border border-white/[0.1]"
        >
          {loading ? "Loading…" : "Refresh balances"}
        </button>
      </div>
    </div>
  );
}
