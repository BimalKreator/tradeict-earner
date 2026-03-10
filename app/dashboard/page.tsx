"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_KEYS_STORAGE_KEY = "tradeict-earner-api-keys";

interface SymbolState {
  symbol: string;
  binanceVWAP: number | null;
  bybitVWAP: number | null;
  binanceFunding: number | null;
  bybitFunding: number | null;
  lastUpdate: number;
  spreadStableMs: number;
  has3xLiquidity: boolean;
}

interface GroupedPosition {
  symbol: string;
  side: "Long" | "Short";
  binance: {
    exchange: "binance";
    quantity: number;
    entryPrice: number;
    markPrice: number;
    liquidationPrice: number;
    unrealizedPnl: number;
    side: "Long" | "Short";
  } | null;
  bybit: {
    exchange: "bybit";
    quantity: number;
    entryPrice: number;
    markPrice: number;
    liquidationPrice: number;
    unrealizedPnl: number;
    side: "Long" | "Short";
  } | null;
  totalQuantity: number;
  entryPrice: number;
  liquidationPrice: number;
  groupPnl: number;
  markPriceBinance: number | null;
  markPriceBybit: number | null;
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

/** Compute live group PnL using VWAP as mark when available. */
function liveGroupPnl(
  pos: GroupedPosition,
  state: SymbolState | undefined
): number {
  const binanceMark = state?.binanceVWAP ?? pos.markPriceBinance;
  const bybitMark = state?.bybitVWAP ?? pos.markPriceBybit;
  if (pos.binance && pos.bybit) {
    const b = pos.binance;
    const y = pos.bybit;
    const markB = binanceMark ?? b.markPrice;
    const markY = bybitMark ?? y.markPrice;
    const pnlB = b.side === "Long" ? (markB - b.entryPrice) * b.quantity : (b.entryPrice - markB) * b.quantity;
    const pnlY = y.side === "Long" ? (markY - y.entryPrice) * y.quantity : (y.entryPrice - markY) * y.quantity;
    return pnlB + pnlY;
  }
  if (pos.binance) {
    const mark = binanceMark ?? pos.binance.markPrice;
    const b = pos.binance;
    return b.side === "Long" ? (mark - b.entryPrice) * b.quantity : (b.entryPrice - mark) * b.quantity;
  }
  if (pos.bybit) {
    const mark = bybitMark ?? pos.bybit.markPrice;
    const y = pos.bybit;
    return y.side === "Long" ? (mark - y.entryPrice) * y.quantity : (y.entryPrice - mark) * y.quantity;
  }
  return pos.groupPnl;
}

export default function DashboardPage() {
  const [positions, setPositions] = useState<GroupedPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [states, setStates] = useState<SymbolState[]>([]);
  const [connected, setConnected] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPositions = useCallback(() => {
    const keys = getApiKeysFromStorage();
    if (!keys.binanceApiKey || !keys.binanceApiSecret || !keys.bybitApiKey || !keys.bybitApiSecret) {
      setPositions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch("/api/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(keys),
    })
      .then((r) => r.json())
      .then((data: { positions?: GroupedPosition[]; error?: string }) => {
        if (data.error) setPositions([]);
        else setPositions(data.positions ?? []);
      })
      .catch(() => setPositions([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hostname = window.location.hostname;
    const ws = new WebSocket(`ws://${hostname}:8080`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type?: string; states?: SymbolState[] };
        if (msg.type === "state" && Array.isArray(msg.states)) setStates(msg.states);
      } catch {}
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, []);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    if (toastRef.current) clearTimeout(toastRef.current);
    setToast({ message, type });
    toastRef.current = setTimeout(() => {
      setToast(null);
      toastRef.current = null;
    }, 4000);
  }, []);

  const exitPosition = useCallback(
    async (pos: GroupedPosition) => {
      const keys = getApiKeysFromStorage();
      if (!keys.binanceApiKey || !keys.binanceApiSecret || !keys.bybitApiKey || !keys.bybitApiSecret) {
        showToast("API keys not configured", "error");
        return;
      }
      setClosingId(pos.symbol);
      try {
        const res = await fetch("/api/trade/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: pos.symbol,
            side: pos.side,
            quantity: pos.totalQuantity,
            ...keys,
          }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (data.ok) {
          showToast("Trade closed successfully via Chunk System", "success");
          fetchPositions();
        } else {
          showToast(data.error ?? "Close failed", "error");
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Close failed", "error");
      } finally {
        setClosingId(null);
      }
    },
    [fetchPositions, showToast]
  );

  const stateBySymbol = useCallback(
    (symbol: string) => states.find((s) => s.symbol === symbol),
    [states]
  );

  const totalPnl = positions.reduce((sum, pos) => sum + liveGroupPnl(pos, stateBySymbol(pos.symbol)), 0);
  const totalPnlFormatted = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Dashboard</h1>
      </div>

      {/* Total PnL hero */}
      <div className="glass-panel p-6 md:p-8">
        <p className="text-slate-400 text-sm font-medium uppercase tracking-wider mb-1">Total unrealized PnL</p>
        <p className={`text-3xl md:text-4xl font-bold ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {loading ? "—" : totalPnlFormatted}
        </p>
        <p className="text-slate-500 text-sm mt-2">
          {connected ? "Tick-by-tick (live VWAP)" : "From exchange mark price"}
        </p>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <div className="glass-panel p-4 md:p-5">
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Open positions</p>
          <p className="text-xl md:text-2xl font-semibold text-white mt-1">{loading ? "—" : positions.length}</p>
          <p className="text-slate-500 text-xs mt-0.5">Grouped</p>
        </div>
        <div className="glass-panel p-4 md:p-5">
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Live data</p>
          <p className="text-xl md:text-2xl font-semibold text-white mt-1">{connected ? "On" : "Off"}</p>
          <p className="text-slate-500 text-xs mt-0.5">WebSocket :8080</p>
        </div>
      </div>

      {/* Active positions – grouped */}
      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Active positions</h2>
          <p className="text-slate-400 text-sm mt-0.5">One row per symbol (both exchanges grouped)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Symbol</th>
                <th className="p-4">Side</th>
                <th className="p-4">Total Qty</th>
                <th className="p-4">Entry</th>
                <th className="p-4">Liquidation</th>
                <th className="p-4 text-right">Group PnL</th>
                <th className="p-4 w-24">Exit</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    Loading positions…
                  </td>
                </tr>
              ) : positions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    No open positions. Save API keys in Settings and open trades from the Screener.
                  </td>
                </tr>
              ) : (
                positions.map((pos) => {
                  const livePnl = liveGroupPnl(pos, stateBySymbol(pos.symbol));
                  const direction =
                    pos.binance && pos.bybit
                      ? pos.side === "Long"
                        ? "Long B / Short Y"
                        : "Short B / Long Y"
                      : pos.side;
                  return (
                    <tr key={pos.symbol} className="border-b border-white/[0.04] last:border-0">
                      <td className="p-4 font-medium text-white">{pos.symbol}</td>
                      <td className="p-4">
                        <span className={pos.side === "Long" ? "text-emerald-400" : "text-amber-400"}>
                          {direction}
                        </span>
                      </td>
                      <td className="p-4 text-slate-300">{pos.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td className="p-4 text-slate-300">
                        ${pos.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                      </td>
                      <td className="p-4 text-slate-300">
                        {pos.liquidationPrice > 0
                          ? `$${pos.liquidationPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
                          : "—"}
                      </td>
                      <td className="p-4 text-right">
                        <span className={livePnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                          {livePnl >= 0 ? "+" : ""}${livePnl.toFixed(2)}
                        </span>
                      </td>
                      <td className="p-4">
                        <button
                          type="button"
                          onClick={() => exitPosition(pos)}
                          disabled={closingId === pos.symbol}
                          className="glass-button px-3 py-2 rounded-xl text-sm font-medium text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {closingId === pos.symbol ? "Closing…" : "Exit"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-3 rounded-xl border shadow-lg max-w-sm ${
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
