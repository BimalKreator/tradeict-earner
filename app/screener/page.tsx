"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface SymbolState {
  symbol: string;
  binanceVWAP: number | null;
  bybitVWAP: number | null;
  binanceFunding: number | null;
  bybitFunding: number | null;
  lastUpdate: number;
  spreadStableMs: number;
  has3xLiquidity: boolean;
}

type FundingFilter = "all" | "favourable";

const FAV_FUNDING_STORAGE_KEY = "tradeict-earner-fav-funding";

/** True if net funding profit for the current direction is > 0. */
function isFavourableFunding(
  binanceVWAP: number | null,
  bybitVWAP: number | null,
  binanceFunding: number | null,
  bybitFunding: number | null
): boolean {
  if (binanceVWAP == null || bybitVWAP == null) return false;
  const bFunding = binanceFunding ?? 0;
  const yFunding = bybitFunding ?? 0;
  if (bybitVWAP > binanceVWAP) return yFunding - bFunding > 0;
  if (binanceVWAP > bybitVWAP) return bFunding - yFunding > 0;
  return false;
}

function formatFundingPct(n: number) {
  const pct = (n * 100).toFixed(4);
  return `${Number(pct) >= 0 ? "+" : ""}${pct}%`;
}

function computeL2SpreadPct(binanceVWAP: number | null, bybitVWAP: number | null): number | null {
  if (binanceVWAP == null || bybitVWAP == null || binanceVWAP === 0) return null;
  return ((bybitVWAP - binanceVWAP) / binanceVWAP) * 100;
}

function computeFundingSpread(binanceFunding: number | null, bybitFunding: number | null): number | null {
  if (binanceFunding == null && bybitFunding == null) return null;
  const b = binanceFunding ?? 0;
  const y = bybitFunding ?? 0;
  return y - b;
}

function getDirection(l2SpreadPct: number | null, fundingSpread: number | null): string {
  if (l2SpreadPct == null) return "—";
  if (l2SpreadPct > 0) return "Long Binance / Short Bybit";
  if (l2SpreadPct < 0) return "Long Bybit / Short Binance";
  return "Neutral";
}

export default function ScreenerPage() {
  const [states, setStates] = useState<SymbolState[]>([]);
  const [connected, setConnected] = useState(false);
  const [tradeAmount, setTradeAmount] = useState(10000);
  const [tokenSearch, setTokenSearch] = useState("");
  const [minL2SpreadPct, setMinL2SpreadPct] = useState<number>(0);
  const [fundingType, setFundingType] = useState<FundingFilter>(() => {
    if (typeof window === "undefined") return "all";
    try {
      const s = localStorage.getItem(FAV_FUNDING_STORAGE_KEY);
      if (s === "all" || s === "favourable") return s;
    } catch {}
    return "all";
  });
  const [onlySafeOpportunities, setOnlySafeOpportunities] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const hostname = window.location.hostname || "localhost";
    const ws = new WebSocket(`ws://${hostname}:8080`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type?: string; states?: SymbolState[] };
        if (msg.type === "state" && Array.isArray(msg.states)) {
          setStates(msg.states);
        }
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, []);

  // Debounce sending trade amount to the WS server
  useEffect(() => {
    const id = window.setTimeout(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const amount = Number(tradeAmount);
      if (!Number.isFinite(amount) || amount <= 0) return;
      try {
        ws.send(JSON.stringify({ action: "set_trade_amount", amount }));
      } catch {
        // ignore send errors
      }
    }, 500);

    return () => {
      window.clearTimeout(id);
    };
  }, [tradeAmount]);

  // Persist Fav Funding filter to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(FAV_FUNDING_STORAGE_KEY, fundingType);
    } catch {}
  }, [fundingType]);

  const filteredRows = useMemo(() => {
    return states
      .map((s) => {
        const l2SpreadPct = computeL2SpreadPct(s.binanceVWAP, s.bybitVWAP);
        const fundingSpread = computeFundingSpread(s.binanceFunding, s.bybitFunding);
        return { state: s, l2SpreadPct, fundingSpread, direction: getDirection(l2SpreadPct, fundingSpread ?? null) };
      })
      .filter((row) => {
        if (tokenSearch.trim()) {
          const q = tokenSearch.trim().toUpperCase();
          if (!row.state.symbol.toUpperCase().includes(q)) return false;
        }
        if (row.l2SpreadPct != null && Math.abs(row.l2SpreadPct) < minL2SpreadPct) return false;
        if (fundingType === "favourable") {
          if (
            !isFavourableFunding(
              row.state.binanceVWAP,
              row.state.bybitVWAP,
              row.state.binanceFunding,
              row.state.bybitFunding
            )
          )
            return false;
        }
        if (onlySafeOpportunities) {
          const stableMs = row.state.spreadStableMs ?? 0;
          const has3x = row.state.has3xLiquidity ?? false;
          if (stableMs < 2000 || !has3x) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aAbs = a.l2SpreadPct != null ? Math.abs(a.l2SpreadPct) : 0;
        const bAbs = b.l2SpreadPct != null ? Math.abs(b.l2SpreadPct) : 0;
        return bAbs - aAbs;
      });
  }, [states, tokenSearch, minL2SpreadPct, fundingType, onlySafeOpportunities]);

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Screener</h1>
          <p className="text-slate-400 text-sm mt-1">
            L2 spread and funding spread between Binance and Bybit (live)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
          <span className="text-slate-400 text-sm">{connected ? "Live" : "Connecting…"}</span>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-panel p-4 md:p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Filters</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Trade amount (USDT)</label>
            <input
              type="number"
              min={100}
              step={100}
              value={tradeAmount}
              onChange={(e) => setTradeAmount(Number(e.target.value) || 10000)}
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Token search</label>
            <input
              type="text"
              placeholder="e.g. BTC, ETH"
              value={tokenSearch}
              onChange={(e) => setTokenSearch(e.target.value)}
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-3 py-2 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Min L2 spread (%)</label>
            <input
              type="number"
              min={0}
              step={0.001}
              value={minL2SpreadPct}
              onChange={(e) => setMinL2SpreadPct(Number(e.target.value) || 0)}
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Fav Funding</label>
            <select
              value={fundingType}
              onChange={(e) => setFundingType(e.target.value as FundingFilter)}
              className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option value="all">Any Funding</option>
              <option value="favourable">Favourable Funding</option>
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 cursor-pointer rounded-xl border border-white/[0.1] bg-white/[0.06] px-3 py-2.5 h-[42px]">
              <input
                type="checkbox"
                checked={onlySafeOpportunities}
                onChange={(e) => setOnlySafeOpportunities(e.target.checked)}
                className="rounded border-white/20 bg-white/10 text-blue-500 focus:ring-blue-500/50"
              />
              <span className="text-sm font-medium text-slate-300">Show only safe opportunities</span>
            </label>
          </div>
        </div>
      </div>

      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Market opportunities</h2>
          <p className="text-slate-400 text-sm mt-0.5">
            {filteredRows.length} of {states.length} symbols
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Pair</th>
                <th className="p-4">Binance VWAP</th>
                <th className="p-4">Bybit VWAP</th>
                <th className="p-4">L2 spread %</th>
                <th className="p-4">Funding (Binance)</th>
                <th className="p-4">Funding (Bybit)</th>
                <th className="p-4">Funding spread</th>
                <th className="p-4">Direction</th>
                <th className="p-4">Stability</th>
                <th className="p-4">Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-8 text-center text-slate-500">
                    {states.length === 0
                      ? connected
                        ? "Waiting for data…"
                        : "Connect to ws://localhost:8080 to see live data."
                      : "No symbols match the current filters."}
                  </td>
                </tr>
              ) : (
                filteredRows.map(({ state: s, l2SpreadPct, fundingSpread, direction }) => (
                  <tr
                    key={s.symbol}
                    className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="p-4 font-medium text-white">{s.symbol}</td>
                    <td className="p-4 text-slate-300">
                      {s.binanceVWAP != null
                        ? `$${s.binanceVWAP.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
                        : "—"}
                    </td>
                    <td className="p-4 text-slate-300">
                      {s.bybitVWAP != null
                        ? `$${s.bybitVWAP.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
                        : "—"}
                    </td>
                    <td className="p-4">
                      {l2SpreadPct != null ? (
                        <span className={l2SpreadPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                          {l2SpreadPct >= 0 ? "+" : ""}
                          {l2SpreadPct.toFixed(4)}%
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="p-4 text-slate-300">
                      {s.binanceFunding != null ? formatFundingPct(s.binanceFunding) : "—"}
                    </td>
                    <td className="p-4 text-slate-300">
                      {s.bybitFunding != null ? formatFundingPct(s.bybitFunding) : "—"}
                    </td>
                    <td className="p-4">
                      {fundingSpread != null ? (
                        <span className={fundingSpread >= 0 ? "text-emerald-400" : "text-amber-400"}>
                          {formatFundingPct(fundingSpread)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="p-4 text-slate-300 text-sm">{direction}</td>
                    <td className="p-4">
                      {(() => {
                        const ms = s.spreadStableMs ?? 0;
                        const sec = (ms / 1000).toFixed(1);
                        if (ms >= 2000) return <span className="text-emerald-400 font-medium">{sec}s</span>;
                        if (ms >= 500) return <span className="text-amber-400">{sec}s</span>;
                        return <span className="text-red-400/90">{sec}s</span>;
                      })()}
                    </td>
                    <td className="p-4">
                      {s.has3xLiquidity ? (
                        <span className="text-emerald-400 font-medium">Safe</span>
                      ) : (
                        <span className="text-red-400/90">Low</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
