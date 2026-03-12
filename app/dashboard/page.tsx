"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

const API_KEYS_STORAGE_KEY = "tradeict-earner-api-keys";
const SETTINGS_STORAGE_KEY = "tradeict-earner-settings";

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

interface PositionLeg {
  exchange: "binance" | "bybit";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  side: "Long" | "Short";
  marginUsed: number;
}

interface GroupedPosition {
  symbol: string;
  side: "Long" | "Short";
  binance: PositionLeg | null;
  bybit: PositionLeg | null;
  totalQuantity: number;
  entryPrice: number;
  liquidationPrice: number;
  groupPnl: number;
  markPriceBinance: number | null;
  markPriceBybit: number | null;
  usedMargin: number;
}

interface SettingsState {
  stoplossPercent: number;
  targetPercent: number;
  feesPercent?: number;
}

function formatNumber(num: number | undefined | null): string {
  if (num == null) return "0.0000";
  return num.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
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

function loadSettings(): SettingsState {
  if (typeof window === "undefined") return { stoplossPercent: 2, targetPercent: 1.5, feesPercent: 0.1 };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { stoplossPercent: 2, targetPercent: 1.5, feesPercent: 0.1 };
    const p = JSON.parse(raw) as Partial<SettingsState & { feesPercent?: number }>;
    return {
      stoplossPercent: typeof p.stoplossPercent === "number" ? p.stoplossPercent : 2,
      targetPercent: typeof p.targetPercent === "number" ? p.targetPercent : 1.5,
      feesPercent: typeof p.feesPercent === "number" ? p.feesPercent : 0.1,
    };
  } catch {
    return { stoplossPercent: 2, targetPercent: 1.5, feesPercent: 0.1 };
  }
}

/** Live group PnL using WS VWAP as mark (tick-by-tick). */
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

/** Per-leg unrealized PnL: entry vs live L2 (VWAP). */
function legPnl(leg: PositionLeg, liveL2: number | null): number {
  const mark = liveL2 ?? leg.markPrice;
  return leg.side === "Long" ? (mark - leg.entryPrice) * leg.quantity : (leg.entryPrice - mark) * leg.quantity;
}

function DownIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

export default function DashboardPage() {
  const [positions, setPositions] = useState<GroupedPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [states, setStates] = useState<SymbolState[]>([]);
  const [connected, setConnected] = useState(false);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [settings, setSettings] = useState<SettingsState>({ stoplossPercent: 2, targetPercent: 1.5, feesPercent: 0.1 });
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
        console.log("Positions Data:", data);
        if (data.error) setPositions([]);
        else setPositions(data.positions ?? []);
      })
      .catch(() => setPositions([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSettings(loadSettings());
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
        const msg = JSON.parse(event.data as string) as {
          type?: string;
          states?: SymbolState[];
          action?: string;
          status?: string;
          done?: boolean;
        };
        if (msg.type === "state" && Array.isArray(msg.states)) setStates(msg.states);
        if (msg.action === "TRADE_UPDATE" && msg.done) {
          setClosingId(null);
          if (msg.status?.startsWith("Trade failed")) {
            setToast({ message: msg.status, type: "error" });
            if (toastRef.current) clearTimeout(toastRef.current);
            toastRef.current = setTimeout(() => {
              setToast(null);
              toastRef.current = null;
            }, 4000);
          } else {
            setToast({ message: "Trade closed successfully", type: "success" });
            if (toastRef.current) clearTimeout(toastRef.current);
            toastRef.current = setTimeout(() => {
              setToast(null);
              toastRef.current = null;
            }, 4000);
            fetchPositions();
          }
        }
      } catch {}
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [fetchPositions]);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    if (toastRef.current) clearTimeout(toastRef.current);
    setToast({ message, type });
    toastRef.current = setTimeout(() => {
      setToast(null);
      toastRef.current = null;
    }, 4000);
  }, []);

  const exitPosition = useCallback(
    (pos: GroupedPosition) => {
      const keys = getApiKeysFromStorage();
      if (!keys.binanceApiKey || !keys.binanceApiSecret || !keys.bybitApiKey || !keys.bybitApiSecret) {
        showToast("API keys not configured", "error");
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast("Not connected to trade server", "error");
        return;
      }
      setClosingId(pos.symbol);
      try {
        const exitSide = pos.side === "Long" ? "Short" : "Long";
        ws.send(
          JSON.stringify({
            action: "EXECUTE_MANUAL_TRADE",
            payload: {
              symbol: pos.symbol,
              side: exitSide,
              quantity: pos.totalQuantity,
              isExit: true,
              ...keys,
            },
          })
        );
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Close failed", "error");
        setClosingId(null);
      }
    },
    [showToast]
  );

  const stateBySymbol = useCallback(
    (symbol: string) => states.find((s) => s.symbol === symbol),
    [states]
  );

  const totalPnl = positions.reduce((sum, pos) => sum + liveGroupPnl(pos, stateBySymbol(pos.symbol)), 0);
  const totalUsedMargin = positions.reduce((sum, pos) => sum + (pos.usedMargin ?? 0), 0);
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

      {/* Active Positions section */}
      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Active Positions</h2>
          <p className="text-slate-400 text-sm mt-0.5">Grouped by symbol with exchange details</p>
        </div>

        {/* Active Trade Summary Bar */}
        {!loading && positions.length > 0 && (
          <div className="grid grid-cols-2 gap-4 p-4 md:p-5 border-b border-white/[0.06] bg-white/[0.03]">
            <div>
              <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Combined PnL</p>
              <p
                className={`text-xl md:text-2xl font-bold mt-0.5 ${
                  totalPnl >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {totalPnlFormatted}
              </p>
            </div>
            <div>
              <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Total Used Margin</p>
              <p className="text-xl md:text-2xl font-bold text-white mt-0.5">
                ${totalUsedMargin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Pair</th>
                <th className="p-4 text-right">Qty</th>
                <th className="p-4">Binance</th>
                <th className="p-4">Bybit</th>
                <th className="p-4 text-right">Combined PnL</th>
                <th className="p-4 w-12"></th>
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
                  const wsState = stateBySymbol(pos.symbol);
                  const combinedPnl = livePnl;
                  const totalMargin = pos.usedMargin ?? 0;
                  const isExpanded = expandedSymbol === pos.symbol;

                  return (
                    <Fragment key={pos.symbol}>
                      <tr
                        className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="p-4 font-medium text-white">{pos.symbol}</td>
                        <td className="p-4 text-right text-slate-300">
                          {pos.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                        </td>
                        <td className="p-4 text-sm">
                          {pos.binance ? (
                            <>
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                <span className="text-white font-medium">Binance</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ml-1 ${pos.binance.side === "Long" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-red-500/20 text-red-400 border border-red-500/30"}`}>
                                  {pos.binance.side}
                                </span>
                              </div>
                              <div className="text-slate-400">Entry: <span className="text-slate-200">${formatNumber(pos.binance.entryPrice)}</span></div>
                              <div className="text-slate-400">Margin: <span className="text-slate-200">${formatNumber(pos.binance.marginUsed)}</span></div>
                              <div className="text-slate-400">PnL: <span className={pos.binance.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}>{pos.binance.unrealizedPnl >= 0 ? "+" : ""}${formatNumber(pos.binance.unrealizedPnl)}</span></div>
                            </>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="p-4 text-sm">
                          {pos.bybit ? (
                            <>
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                <span className="text-white font-medium">Bybit</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ml-1 ${pos.bybit.side === "Long" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-red-500/20 text-red-400 border border-red-500/30"}`}>
                                  {pos.bybit.side}
                                </span>
                              </div>
                              <div className="text-slate-400">Entry: <span className="text-slate-200">${formatNumber(pos.bybit.entryPrice)}</span></div>
                              <div className="text-slate-400">Margin: <span className="text-slate-200">${formatNumber(pos.bybit.marginUsed)}</span></div>
                              <div className="text-slate-400">PnL: <span className={pos.bybit.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}>{pos.bybit.unrealizedPnl >= 0 ? "+" : ""}${formatNumber(pos.bybit.unrealizedPnl)}</span></div>
                            </>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="p-4 text-right">
                          <div className={`text-base font-bold ${combinedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {combinedPnl >= 0 ? "+" : ""}${combinedPnl.toFixed(4)}
                          </div>
                          <div className={`text-xs mt-0.5 ${combinedPnl >= 0 ? "text-emerald-400/80" : "text-red-400/80"}`}>
                            {totalMargin > 0 ? (combinedPnl >= 0 ? "+" : "") + ((combinedPnl / totalMargin) * 100).toFixed(4) + "%" : "0.0000%"}
                          </div>
                        </td>
                        <td className="p-4">
                          <button
                            type="button"
                            onClick={() => setExpandedSymbol(isExpanded ? null : pos.symbol)}
                            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                            aria-expanded={isExpanded}
                          >
                            <DownIcon open={isExpanded} />
                          </button>
                        </td>
                        <td className="p-4">
                          <button
                            type="button"
                            onClick={() => exitPosition(pos)}
                            disabled={!!closingId}
                            className="glass-button px-3 py-2 rounded-xl text-sm font-medium text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {closingId === pos.symbol ? "Exiting…" : "Exit"}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-white/[0.04] border-b border-white/[0.04]">
                          <td colSpan={7} className="p-0">
                            <div className="px-4 pb-4 pt-1 transition-all duration-200 ease-out">
                              {(() => {
                                const stoplossPct = (settings.stoplossPercent ?? 2) / 100;
                                const targetPct = (settings.targetPercent ?? 1.5) / 100;
                                const feesPct = (settings.feesPercent ?? 0.1) / 100;
                                const totalMargin = pos.usedMargin ?? 0;
                                const tradeValue = pos.totalQuantity * pos.entryPrice;
                                const stoplossAmt = totalMargin * stoplossPct;
                                const targetAmt = totalMargin * targetPct + tradeValue * feesPct;
                                return (
                                  <div className="p-4 bg-slate-900/50">
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 text-center">
                                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Combined Liq. Price</p>
                                        <p className="text-slate-300 font-medium text-sm">
                                          {pos.binance?.liquidationPrice != null || pos.bybit?.liquidationPrice != null ? (
                                            <>
                                              B: {pos.binance?.liquidationPrice != null ? `$${formatNumber(pos.binance.liquidationPrice)}` : "—"} / Y: {pos.bybit?.liquidationPrice != null ? `$${formatNumber(pos.bybit.liquidationPrice)}` : "—"}
                                            </>
                                          ) : (
                                            "—"
                                          )}
                                        </p>
                                      </div>
                                      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 text-center">
                                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Stoploss (USD)</p>
                                        <p className="text-red-400 font-medium">-${stoplossAmt.toFixed(4)}</p>
                                      </div>
                                      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 text-center">
                                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Target (USD)</p>
                                        <p className="text-emerald-400 font-medium">+${targetAmt.toFixed(4)}</p>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
