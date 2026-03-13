"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

const OPENING_BALANCES_KEY = "tradeict-earner-opening-balances";

const DEFAULT_OPENING_BINANCE = 65.15;
const DEFAULT_OPENING_BYBIT = 51.3;

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

const DEFAULT_SETTINGS: SettingsState = {
  stoplossPercent: 2,
  targetPercent: 1.5,
  feesPercent: 0.1,
};

function formatNumber(num: number | undefined | null): string {
  if (num == null) return "0.0000";
  return num.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function loadOpeningBalances(): { binance: number; bybit: number } {
  if (typeof window === "undefined") return { binance: DEFAULT_OPENING_BINANCE, bybit: DEFAULT_OPENING_BYBIT };
  try {
    const raw = localStorage.getItem(OPENING_BALANCES_KEY);
    if (!raw) return { binance: DEFAULT_OPENING_BINANCE, bybit: DEFAULT_OPENING_BYBIT };
    const p = JSON.parse(raw) as { binance?: number; bybit?: number };
    return {
      binance: typeof p.binance === "number" && Number.isFinite(p.binance) ? p.binance : DEFAULT_OPENING_BINANCE,
      bybit: typeof p.bybit === "number" && Number.isFinite(p.bybit) ? p.bybit : DEFAULT_OPENING_BYBIT,
    };
  } catch {
    return { binance: DEFAULT_OPENING_BINANCE, bybit: DEFAULT_OPENING_BYBIT };
  }
}

/** Live group PnL using precise deep-exit VWAP (positionStats) when available; else exchange mark. */
function liveGroupPnl(
  pos: GroupedPosition,
  exitVWAPs: { binanceExitVWAP: number; bybitExitVWAP: number } | undefined
): number {
  const binanceMark = exitVWAPs?.binanceExitVWAP ?? pos.markPriceBinance;
  const bybitMark = exitVWAPs?.bybitExitVWAP ?? pos.markPriceBybit;
  if (pos.binance && pos.bybit) {
    const b = pos.binance;
    const y = pos.bybit;
    const markB = (exitVWAPs?.binanceExitVWAP ?? 0) > 0 ? exitVWAPs!.binanceExitVWAP : (binanceMark ?? b.markPrice);
    const markY = (exitVWAPs?.bybitExitVWAP ?? 0) > 0 ? exitVWAPs!.bybitExitVWAP : (bybitMark ?? y.markPrice);
    const pnlB = b.side === "Long" ? (markB - b.entryPrice) * b.quantity : (b.entryPrice - markB) * b.quantity;
    const pnlY = y.side === "Long" ? (markY - y.entryPrice) * y.quantity : (y.entryPrice - markY) * y.quantity;
    return pnlB + pnlY;
  }
  if (pos.binance) {
    const mark = (exitVWAPs?.binanceExitVWAP ?? 0) > 0 ? exitVWAPs!.binanceExitVWAP : (binanceMark ?? pos.binance.markPrice);
    const b = pos.binance;
    return b.side === "Long" ? (mark - b.entryPrice) * b.quantity : (b.entryPrice - mark) * b.quantity;
  }
  if (pos.bybit) {
    const mark = (exitVWAPs?.bybitExitVWAP ?? 0) > 0 ? exitVWAPs!.bybitExitVWAP : (bybitMark ?? pos.bybit.markPrice);
    const y = pos.bybit;
    return y.side === "Long" ? (mark - y.entryPrice) * y.quantity : (y.entryPrice - mark) * y.quantity;
  }
  return pos.groupPnl;
}

/** Per-leg unrealized PnL: use precise exit VWAP when available, else leg mark price. */
function legPnl(
  leg: PositionLeg,
  exitVWAP: number | null
): number {
  const mark = (exitVWAP != null && exitVWAP > 0) ? exitVWAP : leg.markPrice;
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
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [positionStats, setPositionStats] = useState<Record<string, { binanceExitVWAP: number; bybitExitVWAP: number }>>({});
  const [openingBalances, setOpeningBalances] = useState<{ binance: number; bybit: number }>({
    binance: DEFAULT_OPENING_BINANCE,
    bybit: DEFAULT_OPENING_BYBIT,
  });
  const [balances, setBalances] = useState<{ binance: number; bybit: number } | null>(null);
  const [wsActiveSymbols, setWsActiveSymbols] = useState<string[]>([]);
  const { data: session } = useSession();
  const wsRef = useRef<WebSocket | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPositions = useCallback(() => {
    setLoading(true);
    fetch("/api/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json())
      .then((data: { positions?: GroupedPosition[]; error?: string }) => {
        if (data.error) setPositions([]);
        else setPositions(data.positions ?? []);
      })
      .catch(() => setPositions([]))
      .finally(() => setLoading(false));
  }, []);

  // Sync stoploss/target from backend so Dashboard matches Settings (PC and mobile).
  useEffect(() => {
    fetch("/api/settings/config")
      .then((r) => r.json())
      .then((data: Partial<SettingsState>) => {
        setSettings({
          stoplossPercent: typeof data.stoplossPercent === "number" ? data.stoplossPercent : DEFAULT_SETTINGS.stoplossPercent,
          targetPercent: typeof data.targetPercent === "number" ? data.targetPercent : DEFAULT_SETTINGS.targetPercent,
          feesPercent: typeof data.feesPercent === "number" ? data.feesPercent : DEFAULT_SETTINGS.feesPercent,
        });
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    setOpeningBalances(loadOpeningBalances());
  }, []);

  useEffect(() => {
    const onFocus = () => setOpeningBalances(loadOpeningBalances());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const fetchBalances = useCallback(() => {
    fetch("/api/settings/balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json())
      .then((data: { binance?: { total?: number }; bybit?: { total?: number }; error?: string }) => {
        if (data.error || (data.binance == null && data.bybit == null)) {
          setBalances(null);
          return;
        }
        setBalances({
          binance: typeof data.binance?.total === "number" ? data.binance.total : 0,
          bybit: typeof data.bybit?.total === "number" ? data.bybit.total : 0,
        });
      })
      .catch(() => setBalances(null));
  }, []);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  useEffect(() => {
    fetchPositions();
  }, [wsActiveSymbols, fetchPositions]);

  useEffect(() => {
    const id = setInterval(fetchPositions, 10000);
    return () => clearInterval(id);
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
          activePositions?: string[];
          positionStats?: Record<string, { binanceExitVWAP: number; bybitExitVWAP: number }>;
          action?: string;
          status?: string;
          done?: boolean;
        };
        if (msg.type === "state" && Array.isArray(msg.states)) setStates(msg.states);
        if (msg.type === "state" && msg.positionStats && typeof msg.positionStats === "object") {
          setPositionStats(msg.positionStats as Record<string, { binanceExitVWAP: number; bybitExitVWAP: number }>);
        }
        if (msg.type === "state" && Array.isArray(msg.activePositions)) {
          const next = msg.activePositions.map((s) => String(s).toUpperCase()).sort();
          setWsActiveSymbols((prev) => {
            if (prev.length !== next.length) return next;
            if (prev.join(",") === next.join(",")) return prev;
            return next;
          });
        }
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
      if (!session?.user?.email) {
        showToast("Not signed in", "error");
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
              userEmail: session.user.email,
            },
          })
        );
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Close failed", "error");
        setClosingId(null);
      }
    },
    [showToast, session]
  );

  const totalPnl = positions.reduce(
    (sum, pos) => sum + liveGroupPnl(pos, positionStats[pos.symbol]),
    0
  );
  const totalUsedMargin = positions.reduce((sum, pos) => sum + (pos.usedMargin ?? 0), 0);
  const totalPnlFormatted = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;

  const totalOpening = openingBalances.binance + openingBalances.bybit;
  const totalCurrent = (balances?.binance ?? 0) + (balances?.bybit ?? 0);
  const todaysProfit = balances != null ? totalCurrent - totalOpening : null;
  const todaysProfitFormatted =
    todaysProfit != null
      ? (todaysProfit >= 0 ? `+$${todaysProfit.toFixed(2)}` : `-$${Math.abs(todaysProfit).toFixed(2)}`)
      : "—";
  const openingBreakdown = `Total Opening: $${totalOpening.toFixed(2)} (Binance: $${openingBalances.binance.toFixed(2)} | Bybit: $${openingBalances.bybit.toFixed(2)})`;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Dashboard</h1>
      </div>

      {/* Summary cards: Total unrealized PnL + Today's Profit */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        <div className="glass-panel p-6 md:p-8">
          <p className="text-slate-400 text-sm font-medium uppercase tracking-wider mb-1">Total unrealized PnL</p>
          <p className={`text-3xl md:text-4xl font-bold ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {loading ? "—" : totalPnlFormatted}
          </p>
          <p className="text-slate-500 text-sm mt-2">
            {connected ? "Deep exit VWAP (matches auto-exit engine)" : "From exchange mark price"}
          </p>
        </div>
        <div className="glass-panel p-6 md:p-8">
          <p className="text-slate-400 text-sm font-medium uppercase tracking-wider mb-1">Today&apos;s Profit</p>
          <p
            className={`text-3xl md:text-4xl font-bold ${
              todaysProfit != null
                ? todaysProfit >= 0
                  ? "text-emerald-400"
                  : "text-red-400"
                : "text-slate-400"
            }`}
          >
            {todaysProfitFormatted}
          </p>
          <p className="text-slate-500 text-sm mt-2">{openingBreakdown}</p>
        </div>
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
                <th className="p-4">Token Name</th>
                <th className="p-4 text-right">Stoploss Amount (USD)</th>
                <th className="p-4 text-right">Target Amount (USD)</th>
                <th className="p-4 text-right">Combined PnL</th>
                <th className="p-4 w-12"></th>
                <th className="p-4 w-24">Exit</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    Loading positions…
                  </td>
                </tr>
              ) : positions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    No open positions. Save API keys in Settings and open trades from the Screener.
                  </td>
                </tr>
              ) : (
                positions.map((pos) => {
                  const exitVWAPs = positionStats[pos.symbol];
                  const combinedPnl = liveGroupPnl(pos, exitVWAPs);
                  const totalMargin = pos.usedMargin ?? 0;
                  const stoplossPct = settings.stoplossPercent / 100;
                  const targetPct = settings.targetPercent / 100;
                  const feesPct = (settings.feesPercent ?? 0.1) / 100;
                  const tradeValue = pos.totalQuantity * pos.entryPrice;
                  const stoplossAmt = totalMargin * stoplossPct;
                  const targetAmt = totalMargin * targetPct + tradeValue * feesPct;
                  const isExpanded = expandedSymbol === pos.symbol;

                  return (
                    <Fragment key={pos.symbol}>
                      <tr className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                        <td className="p-4 font-medium text-white">{pos.symbol}</td>
                        <td className="p-4 text-right text-red-300/90">${stoplossAmt.toFixed(4)}</td>
                        <td className="p-4 text-right text-emerald-300/90">${targetAmt.toFixed(4)}</td>
                        <td className="p-4 text-right">
                          <div className={`text-base font-bold ${combinedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {combinedPnl >= 0 ? "+" : ""}${combinedPnl.toFixed(4)}
                          </div>
                          {totalMargin > 0 && (
                            <div className={`text-xs mt-0.5 ${combinedPnl >= 0 ? "text-emerald-400/80" : "text-red-400/80"}`}>
                              {(combinedPnl >= 0 ? "+" : "") + ((combinedPnl / totalMargin) * 100).toFixed(4)}%
                            </div>
                          )}
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
                          <td colSpan={6} className="p-0">
                            <div className="px-4 pb-4 pt-1">
                              <table className="w-full text-sm border-collapse">
                                <thead>
                                  <tr className="text-slate-400 text-xs uppercase tracking-wider border-b border-white/[0.06]">
                                    <th className="p-3 text-left">Exchange</th>
                                    <th className="p-3 text-left">Trade Side</th>
                                    <th className="p-3 text-right">Quantity</th>
                                    <th className="p-3 text-right">Entry Price</th>
                                    <th className="p-3 text-right">Liquidation Price</th>
                                    <th className="p-3 text-right">Margin Used</th>
                                    <th className="p-3 text-right">Realtime L2 VWAP</th>
                                    <th className="p-3 text-right">Unrealised PnL</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {pos.binance && (
                                    <tr className="border-b border-white/[0.04]">
                                      <td className="p-3 font-medium text-amber-300/90">Binance</td>
                                      <td className="p-3">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${pos.binance.side === "Long" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-red-500/20 text-red-400 border border-red-500/30"}`}>
                                          {pos.binance.side}
                                        </span>
                                      </td>
                                      <td className="p-3 text-right text-slate-300">{pos.binance.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                                      <td className="p-3 text-right text-slate-300">${formatNumber(pos.binance.entryPrice)}</td>
                                      <td className="p-3 text-right text-slate-300">${formatNumber(pos.binance.liquidationPrice)}</td>
                                      <td className="p-3 text-right text-slate-300">${formatNumber(pos.binance.marginUsed)}</td>
                                      <td className="p-3 text-right text-slate-200">${formatNumber((exitVWAPs?.binanceExitVWAP ?? 0) > 0 ? exitVWAPs!.binanceExitVWAP : pos.binance.markPrice)}</td>
                                      <td className="p-3 text-right">
                                        <span className={legPnl(pos.binance, (exitVWAPs?.binanceExitVWAP ?? 0) > 0 ? exitVWAPs!.binanceExitVWAP : null) >= 0 ? "text-emerald-400" : "text-red-400"}>
                                          {legPnl(pos.binance, (exitVWAPs?.binanceExitVWAP ?? 0) > 0 ? exitVWAPs!.binanceExitVWAP : null) >= 0 ? "+" : ""}${legPnl(pos.binance, (exitVWAPs?.binanceExitVWAP ?? 0) > 0 ? exitVWAPs!.binanceExitVWAP : null).toFixed(4)}
                                        </span>
                                      </td>
                                    </tr>
                                  )}
                                  {pos.bybit && (
                                    <tr className="border-b border-white/[0.04] last:border-0">
                                      <td className="p-3 font-medium text-blue-300/90">Bybit</td>
                                      <td className="p-3">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${pos.bybit.side === "Long" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-red-500/20 text-red-400 border border-red-500/30"}`}>
                                          {pos.bybit.side}
                                        </span>
                                      </td>
                                      <td className="p-3 text-right text-slate-300">{pos.bybit.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                                      <td className="p-3 text-right text-slate-300">${formatNumber(pos.bybit.entryPrice)}</td>
                                      <td className="p-3 text-right text-slate-300">${formatNumber(pos.bybit.liquidationPrice)}</td>
                                      <td className="p-3 text-right text-slate-300">${formatNumber(pos.bybit.marginUsed)}</td>
                                      <td className="p-3 text-right text-slate-200">${formatNumber((exitVWAPs?.bybitExitVWAP ?? 0) > 0 ? exitVWAPs!.bybitExitVWAP : pos.bybit.markPrice)}</td>
                                      <td className="p-3 text-right">
                                        <span className={legPnl(pos.bybit, (exitVWAPs?.bybitExitVWAP ?? 0) > 0 ? exitVWAPs!.bybitExitVWAP : null) >= 0 ? "text-emerald-400" : "text-red-400"}>
                                          {legPnl(pos.bybit, (exitVWAPs?.bybitExitVWAP ?? 0) > 0 ? exitVWAPs!.bybitExitVWAP : null) >= 0 ? "+" : ""}${legPnl(pos.bybit, (exitVWAPs?.bybitExitVWAP ?? 0) > 0 ? exitVWAPs!.bybitExitVWAP : null).toFixed(4)}
                                        </span>
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
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
