/**
 * Phase 3.6: Auto-Exit Engine.
 * Event-driven: 3s position poller + dynamic Binance/Bybit WebSocket subscriptions.
 * L2 depth updates trigger immediate PnL check and exit (no polling, no REST).
 */

import WebSocket from "ws";
import {
  getBinancePositions,
  getBybitPositions,
  getBybitOrderbookFast,
  executeCloseTrade,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
  type RawPosition,
  type ExchangeCredentials,
  type PrivateWSManager,
} from "./execution-engine";

const BINANCE_FUTURES_WS = "wss://fstream.binance.com/stream";
const BYBIT_LINEAR_WS = "wss://stream.bybit.com/v5/public/linear";
const ORPHAN_EXIT_THRESHOLD_MS = 30_000;
const POS_POLL_MS = 3000;
const MAX_ORDERBOOK_LEVELS = 20;

let cachedPositions: GroupedPosition[] = [];
let isFetchingPositions = false;
let posIntervalId: ReturnType<typeof setInterval> | null = null;

interface GroupedPosition {
  symbol: string;
  side: OrderSide;
  binance: RawPosition | null;
  bybit: RawPosition | null;
  totalQuantity: number;
  entryPrice: number;
  usedMargin: number;
}

interface OrderbookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
}

function normalizeSymbol(s: string): string {
  return (s || "").toUpperCase();
}

function applyDepthDelta(
  ob: OrderbookState,
  levels: [string, string][],
  side: "bids" | "asks"
): void {
  const map = side === "bids" ? ob.bids : ob.asks;
  for (const [p, q] of levels) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (qty === 0) map.delete(price);
    else map.set(price, qty);
  }

  if (ob.bids.size > MAX_ORDERBOOK_LEVELS) {
    const sorted = Array.from(ob.bids.entries()).sort((a, b) => b[0] - a[0]);
    ob.bids.clear();
    for (let i = 0; i < MAX_ORDERBOOK_LEVELS && i < sorted.length; i++) ob.bids.set(sorted[i][0], sorted[i][1]);
  }
  if (ob.asks.size > MAX_ORDERBOOK_LEVELS) {
    const sorted = Array.from(ob.asks.entries()).sort((a, b) => a[0] - b[0]);
    ob.asks.clear();
    for (let i = 0; i < MAX_ORDERBOOK_LEVELS && i < sorted.length; i++) ob.asks.set(sorted[i][0], sorted[i][1]);
  }
}

function orderbookToSnapshot(symbol: string, ob: OrderbookState): OrderbookSnapshot {
  const bids: [string, string][] = Array.from(ob.bids.entries())
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, MAX_ORDERBOOK_LEVELS)
    .map(([p, q]) => [String(p), String(q)]);
  const asks: [string, string][] = Array.from(ob.asks.entries())
    .filter(([, q]) => q > 0)
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_ORDERBOOK_LEVELS)
    .map(([p, q]) => [String(p), String(q)]);
  return { symbol, bids, asks };
}

function groupPositions(binance: RawPosition[], bybit: RawPosition[]): GroupedPosition[] {
  const bySymbol = new Map<string, { binance: RawPosition | null; bybit: RawPosition | null }>();
  for (const p of binance) {
    const key = normalizeSymbol(p.symbol);
    const cur = bySymbol.get(key) ?? { binance: null, bybit: null };
    cur.binance = p;
    bySymbol.set(key, cur);
  }
  for (const p of bybit) {
    const key = normalizeSymbol(p.symbol);
    const cur = bySymbol.get(key) ?? { binance: null, bybit: null };
    cur.bybit = p;
    bySymbol.set(key, cur);
  }

  const out: GroupedPosition[] = [];
  for (const [symbol, legs] of Array.from(bySymbol.entries())) {
    const b = legs.binance;
    const y = legs.bybit;
    if (!b && !y) continue;
    const totalQuantity = b && y ? Math.min(b.quantity, y.quantity) : (b?.quantity ?? 0) + (y?.quantity ?? 0);
    if (totalQuantity <= 0) continue;

    const side: OrderSide = b?.side ?? y?.side ?? "Long";
    let entryPrice = 0;
    let usedMargin = 0;
    if (b && y) {
      const notionalB = b.quantity * b.entryPrice;
      const notionalY = y.quantity * y.entryPrice;
      entryPrice = (notionalB + notionalY) / (b.quantity + y.quantity);
      usedMargin = (b.marginUsed ?? 0) + (y.marginUsed ?? 0);
    } else if (b) {
      entryPrice = b.entryPrice;
      usedMargin = b.marginUsed ?? 0;
    } else if (y) {
      entryPrice = y.entryPrice;
      usedMargin = y.marginUsed ?? 0;
    }

    out.push({ symbol, side, binance: b ?? null, bybit: y ?? null, totalQuantity, entryPrice, usedMargin });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function getVWAP(levels: [string, string][], targetNotional: number): number {
  let notionalSum = 0;
  let qtySum = 0;
  for (const [pStr, qStr] of levels) {
    const p = parseFloat(pStr);
    const q = parseFloat(qStr);
    const levelNotional = p * q;
    if (notionalSum + levelNotional >= targetNotional) {
      const neededNotional = targetNotional - notionalSum;
      const neededQty = neededNotional / p;
      notionalSum += neededNotional;
      qtySum += neededQty;
      break;
    }
    notionalSum += levelNotional;
    qtySum += q;
  }
  return qtySum > 0 ? notionalSum / qtySum : 0;
}

function combinedPnlFromL2(pos: GroupedPosition, orderbook: OrderbookSnapshot): number {
  if (!orderbook) return 0;
  let pnl = 0;
  if (pos.binance) {
    const b = pos.binance;
    const targetNotional = b.quantity * b.entryPrice;
    const levels = b.side === "Long" ? orderbook.bids : orderbook.asks;
    const exitVwap = getVWAP(levels, targetNotional) || parseFloat(levels[0]?.[0] || "0");
    if (exitVwap > 0) {
      pnl += b.side === "Long" ? (exitVwap - b.entryPrice) * b.quantity : (b.entryPrice - exitVwap) * b.quantity;
    }
  }
  if (pos.bybit) {
    const y = pos.bybit;
    const targetNotional = y.quantity * y.entryPrice;
    const levels = y.side === "Long" ? orderbook.bids : orderbook.asks;
    const exitVwap = getVWAP(levels, targetNotional) || parseFloat(levels[0]?.[0] || "0");
    if (exitVwap > 0) {
      pnl += y.side === "Long" ? (exitVwap - y.entryPrice) * y.quantity : (y.entryPrice - exitVwap) * y.quantity;
    }
  }
  return pnl;
}

/** Combined PnL using each exchange's own orderbook for its leg (matches dashboard logic). */
function combinedPnlFromL2TwoBooks(
  pos: GroupedPosition,
  binanceSnapshot: OrderbookSnapshot | null,
  bybitSnapshot: OrderbookSnapshot | null
): number {
  let pnl = 0;
  if (pos.binance && binanceSnapshot?.bids?.length && binanceSnapshot?.asks?.length) {
    const b = pos.binance;
    const targetNotional = b.quantity * b.entryPrice;
    const levels = b.side === "Long" ? binanceSnapshot.bids : binanceSnapshot.asks;
    const exitVwap = getVWAP(levels, targetNotional) || parseFloat(levels[0]?.[0] || "0");
    if (exitVwap > 0) {
      pnl += b.side === "Long" ? (exitVwap - b.entryPrice) * b.quantity : (b.entryPrice - exitVwap) * b.quantity;
    }
  }
  if (pos.bybit && bybitSnapshot?.bids?.length && bybitSnapshot?.asks?.length) {
    const y = pos.bybit;
    const targetNotional = y.quantity * y.entryPrice;
    const levels = y.side === "Long" ? bybitSnapshot.bids : bybitSnapshot.asks;
    const exitVwap = getVWAP(levels, targetNotional) || parseFloat(levels[0]?.[0] || "0");
    if (exitVwap > 0) {
      pnl += y.side === "Long" ? (exitVwap - y.entryPrice) * y.quantity : (y.entryPrice - exitVwap) * y.quantity;
    }
  }
  return pnl;
}

export interface AutoExitContext {
  credentials: ExchangeCredentials;
  privateWs: PrivateWSManager;
  fetchOrderbook: (symbol: string) => Promise<OrderbookSnapshot>;
  getLiveOrderbook?: (symbol: string) => OrderbookSnapshot | null;
  defaultSettings: ExecutionSettings;
}

/**
 * Event-driven Auto-Exit: 3s position poller + dynamic WS subscriptions.
 * Depth updates trigger immediate L2 VWAP PnL check and exit (zero polling latency).
 */
export function startAutoExitMonitor(
  getSettings: () => ExecutionSettings,
  getContext: () => AutoExitContext | null
): () => void {
  const exitLocks = new Set<string>();
  const orphanFirstSeen = new Map<string, number>();
  const subscribedSymbols = new Set<string>();
  const binanceOrderbooks = new Map<string, OrderbookState>();
  const bybitOrderbooks = new Map<string, OrderbookState>();

  let binanceWs: WebSocket | null = null;
  let bybitWs: WebSocket | null = null;

  const connectBinance = (symbols: string[]) => {
    if (binanceWs) {
      binanceWs.removeAllListeners();
      binanceWs.close();
      binanceWs = null;
    }
    if (symbols.length === 0) return;
    const streams = symbols.map((s) => `${s.toLowerCase()}@depth20@100ms`);
    const url = `${BINANCE_FUTURES_WS}?streams=${streams.join("/")}`;
    binanceWs = new WebSocket(url);

    binanceWs.on("open", () => {
      console.log("[CHUNK-SYSTEM] Auto-Exit Binance depth WS connected.");
    });

    binanceWs.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { stream?: string; data?: unknown };
        const d = msg.data as Record<string, unknown> | undefined;
        if (!d) return;
        const symbol = String(d.s ?? "").toUpperCase();
        if (!symbol || !subscribedSymbols.has(symbol)) return;

        const stream = msg.stream ?? "";
        if (!stream.endsWith("@depth20@100ms")) return;

        const b = (d.b as [string, string][] | undefined) ?? [];
        const a = (d.a as [string, string][] | undefined) ?? [];
        let ob = binanceOrderbooks.get(symbol);
        if (!ob) {
          ob = { bids: new Map(), asks: new Map() };
          binanceOrderbooks.set(symbol, ob);
        }
        applyDepthDelta(ob, b, "bids");
        applyDepthDelta(ob, a, "asks");

        onDepthUpdate(symbol);
      } catch (e) {
        console.error("[CHUNK-SYSTEM] Auto-Exit Binance message error:", e);
      }
    });

    binanceWs.on("error", (err) => console.error("[CHUNK-SYSTEM] Auto-Exit Binance WS error:", err));
    binanceWs.on("close", () => {
      console.log("[CHUNK-SYSTEM] Auto-Exit Binance depth WS closed.");
    });
  };

  const connectBybit = () => {
    if (bybitWs) return;
    bybitWs = new WebSocket(BYBIT_LINEAR_WS);
    bybitWs.on("open", () => {
      console.log("[CHUNK-SYSTEM] Auto-Exit Bybit depth WS connected.");
      syncBybitSubscriptions();
    });
    bybitWs.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { topic?: string; type?: string; data?: Record<string, unknown> };
        const topic = msg.topic ?? "";
        if (!topic.startsWith("orderbook.")) return;
        const symbol = topic.split(".").pop() as string;
        if (!symbol || !subscribedSymbols.has(symbol)) return;
        const d = msg.data;
        if (!d) return;

        const b = (d.b as [string, string][] | undefined) ?? [];
        const a = (d.a as [string, string][] | undefined) ?? [];
        let ob = bybitOrderbooks.get(symbol);
        if (!ob) {
          ob = { bids: new Map(), asks: new Map() };
          bybitOrderbooks.set(symbol, ob);
        }
        if (msg.type === "snapshot") {
          ob.bids.clear();
          ob.asks.clear();
        }
        applyDepthDelta(ob, b, "bids");
        applyDepthDelta(ob, a, "asks");
        onDepthUpdate(symbol);
      } catch (e) {
        console.error("[CHUNK-SYSTEM] Auto-Exit Bybit message error:", e);
      }
    });
    bybitWs.on("error", (err) => console.error("[CHUNK-SYSTEM] Auto-Exit Bybit WS error:", err));
    bybitWs.on("close", () => {
      console.log("[CHUNK-SYSTEM] Auto-Exit Bybit depth WS closed.");
    });
  };

  const syncBybitSubscriptions = () => {
    if (!bybitWs || bybitWs.readyState !== WebSocket.OPEN) return;
    const args = Array.from(subscribedSymbols).map((s) => `orderbook.50.${s}`);
    if (args.length > 0) {
      bybitWs.send(JSON.stringify({ op: "subscribe", args }));
    }
  };

  const onDepthUpdate = (symbol: string) => {
    const ctx = getContext();
    if (!ctx) return;
    const settings = getSettings();
    if (!settings.autoExit) return;

    const pos = cachedPositions.find((p) => normalizeSymbol(p.symbol) === symbol);
    if (!pos || exitLocks.has(pos.symbol)) return;

    const binanceObRaw = binanceOrderbooks.get(symbol);
    const bybitObRaw = bybitOrderbooks.get(symbol);

    if (!binanceObRaw && !bybitObRaw) return;

    const binanceSnap = binanceObRaw && binanceObRaw.bids.size > 0 ? orderbookToSnapshot(symbol, binanceObRaw) : null;
    const bybitSnap = bybitObRaw && bybitObRaw.bids.size > 0 ? orderbookToSnapshot(symbol, bybitObRaw) : null;

    if (pos.binance && !binanceSnap) return;
    if (pos.bybit && !bybitSnap) return;

    const combinedPnl = combinedPnlFromL2TwoBooks(pos, binanceSnap, bybitSnap);
    const stoplossPct = (settings.stoplossPercent ?? 2) / 100;
    const targetPct = (settings.targetPercent ?? 1.5) / 100;
    const feesPct = (settings.feesPercent ?? 0.1) / 100;

    // Bulletproof property extraction to prevent NaN
    const posAny = pos as any;
    const qty = Number(posAny.quantity ?? posAny.qty ?? posAny.totalQuantity ?? 0) || 0;
    const entryPrice = Number(posAny.entryPrice ?? posAny.avgEntryPrice ?? 0) || 0;
    const margin = Number(posAny.marginUsed ?? posAny.usedMargin ?? 0) || 0;

    const tradeValue = qty * entryPrice;

    // Stoploss = Margin used x stoploss%
    const stoplossAmount = margin * stoplossPct;

    // Target = (Margin used x Target%) + (Trade Value x Fees%)
    const targetAmount = (margin * targetPct) + (tradeValue * feesPct);

    // Occasional debug log (~2% of the time) to verify values
    if (Math.random() < 0.02) {
      console.log(`[AUTO-EXIT Tracker] ${symbol} | Live PnL: $${combinedPnl.toFixed(4)} | Target: $${targetAmount.toFixed(4)} | SL: -$${stoplossAmount.toFixed(4)} | Margin: $${margin.toFixed(2)}`);
    }

    if (combinedPnl >= targetAmount && targetAmount > 0) {
      exitLocks.add(pos.symbol);
      console.log(`[CHUNK-SYSTEM] Auto-Exit: ${pos.symbol} target hit! PnL=$${combinedPnl.toFixed(4)} >= Target=$${targetAmount.toFixed(4)}. Triggering exit.`);
      triggerExit(pos, ctx).finally(() => exitLocks.delete(pos.symbol));
    } else if (combinedPnl <= -stoplossAmount) {
      exitLocks.add(pos.symbol);
      console.log(`[CHUNK-SYSTEM] Auto-Exit: ${pos.symbol} stoploss hit! PnL=$${combinedPnl.toFixed(4)} <= -SL=$${stoplossAmount.toFixed(4)}. Triggering exit.`);
      triggerExit(pos, ctx).finally(() => exitLocks.delete(pos.symbol));
    }
  };

  const fetchPositionsIntoCache = async () => {
    const settings = getSettings();
    if (!settings.autoExit || isFetchingPositions) return;
    isFetchingPositions = true;
    try {
      const ctx = getContext();
      if (!ctx) return;
      const [binanceList, bybitList] = await Promise.all([
        getBinancePositions(ctx.credentials.binance.apiKey, ctx.credentials.binance.apiSecret),
        getBybitPositions(ctx.credentials.bybit.apiKey, ctx.credentials.bybit.apiSecret),
      ]);
      const activeBinance = binanceList.filter((p) => p.quantity > 0);
      const activeBybit = bybitList.filter((p) => p.quantity > 0);
      cachedPositions = groupPositions(activeBinance, activeBybit);

      const activeSymbols = new Set(cachedPositions.map((p) => normalizeSymbol(p.symbol)));

      // Orphan check (in 3s loop)
      for (const pos of cachedPositions) {
        if (exitLocks.has(pos.symbol)) continue;
        const isOrphan = !pos.binance || !pos.bybit;
        if (isOrphan) {
          const now = Date.now();
          const firstSeen = orphanFirstSeen.get(pos.symbol) ?? now;
          orphanFirstSeen.set(pos.symbol, firstSeen);
          if (now - firstSeen > ORPHAN_EXIT_THRESHOLD_MS) {
            orphanFirstSeen.delete(pos.symbol);
            exitLocks.add(pos.symbol);
            console.log(`[CHUNK-SYSTEM] Auto-Exit: orphan ${pos.symbol} (one leg > 30s). Triggering exit.`);
            triggerExit(pos, ctx).finally(() => exitLocks.delete(pos.symbol));
          }
          continue;
        }
        orphanFirstSeen.delete(pos.symbol);
      }

      // REST fallback: re-check target/stoploss with fresh orderbooks (in case depth WS missed updates)
      for (const pos of cachedPositions) {
        if (exitLocks.has(pos.symbol) || !pos.binance || !pos.bybit) continue;
        try {
          const [binanceOb, bybitBest] = await Promise.all([
            ctx.fetchOrderbook(pos.symbol),
            getBybitOrderbookFast(pos.symbol),
          ]);
          const bybitSnapshot: OrderbookSnapshot | null =
            bybitBest.bestBid > 0 && bybitBest.bestAsk > 0
              ? {
                  symbol: pos.symbol,
                  bids: [[String(bybitBest.bestBid), "1"]],
                  asks: [[String(bybitBest.bestAsk), "1"]],
                }
              : null;
          const binanceSnapshot =
            binanceOb?.bids?.length && binanceOb?.asks?.length ? binanceOb : null;
          if (!binanceSnapshot && !bybitSnapshot) continue;
          const combinedPnl = combinedPnlFromL2TwoBooks(pos, binanceSnapshot, bybitSnapshot);
          const settings = getSettings();
          const stoplossPct = (settings.stoplossPercent ?? 2) / 100;
          const targetPct = (settings.targetPercent ?? 1.5) / 100;
          const feesPct = (settings.feesPercent ?? 0.1) / 100;
          const posAny = pos as any;
          const qty = Number(posAny.quantity ?? posAny.qty ?? posAny.totalQuantity ?? 0) || 0;
          const entryPrice = Number(posAny.entryPrice ?? posAny.avgEntryPrice ?? 0) || 0;
          const margin = Number(posAny.marginUsed ?? posAny.usedMargin ?? 0) || 0;
          const tradeValue = qty * entryPrice;
          const stoplossAmount = margin * stoplossPct;
          const targetAmount = (margin * targetPct) + (tradeValue * feesPct);
          if (combinedPnl >= targetAmount && targetAmount > 0) {
            exitLocks.add(pos.symbol);
            console.log(`[CHUNK-SYSTEM] Auto-Exit (REST): ${pos.symbol} target hit! PnL=$${combinedPnl.toFixed(4)} >= Target=$${targetAmount.toFixed(4)}. Triggering exit.`);
            triggerExit(pos, ctx).finally(() => exitLocks.delete(pos.symbol));
            break;
          }
          if (combinedPnl <= -stoplossAmount) {
            exitLocks.add(pos.symbol);
            console.log(`[CHUNK-SYSTEM] Auto-Exit (REST): ${pos.symbol} stoploss hit! PnL=$${combinedPnl.toFixed(4)}. Triggering exit.`);
            triggerExit(pos, ctx).finally(() => exitLocks.delete(pos.symbol));
            break;
          }
        } catch (e) {
          // ignore REST fallback errors
        }
      }

      // Dynamic subscriptions: SUBSCRIBE for active, UNSUBSCRIBE for inactive
      const toAdd = Array.from(activeSymbols).filter((s) => !subscribedSymbols.has(s));
      const toRemove = Array.from(subscribedSymbols).filter((s) => !activeSymbols.has(s));

      for (const s of toRemove) {
        subscribedSymbols.delete(s);
        binanceOrderbooks.delete(s);
        bybitOrderbooks.delete(s);
      }
      for (const s of toAdd) {
        subscribedSymbols.add(s);
        if (!binanceOrderbooks.has(s)) {
          binanceOrderbooks.set(s, { bids: new Map(), asks: new Map() });
        }
        if (!bybitOrderbooks.has(s)) {
          bybitOrderbooks.set(s, { bids: new Map(), asks: new Map() });
        }
      }

      if (toRemove.length > 0 && bybitWs?.readyState === WebSocket.OPEN) {
        bybitWs.send(JSON.stringify({ op: "unsubscribe", args: toRemove.map((s) => `orderbook.50.${s}`) }));
      }
      if (toAdd.length > 0 && bybitWs?.readyState === WebSocket.OPEN) {
        bybitWs.send(JSON.stringify({ op: "subscribe", args: toAdd.map((s) => `orderbook.50.${s}`) }));
      }

      if (toAdd.length > 0 || toRemove.length > 0) {
        connectBinance(Array.from(subscribedSymbols));
      }
      if (subscribedSymbols.size > 0 && !bybitWs) {
        connectBybit();
      }
    } catch {
      // suppress position fetch errors
    } finally {
      isFetchingPositions = false;
    }
  };

  if (posIntervalId) clearInterval(posIntervalId);
  posIntervalId = setInterval(fetchPositionsIntoCache, POS_POLL_MS);
  void fetchPositionsIntoCache();

  return () => {
    if (posIntervalId) {
      clearInterval(posIntervalId);
      posIntervalId = null;
    }
    if (binanceWs) {
      binanceWs.removeAllListeners();
      binanceWs.close();
      binanceWs = null;
    }
    if (bybitWs) {
      bybitWs.removeAllListeners();
      bybitWs.close();
      bybitWs = null;
    }
    subscribedSymbols.clear();
    binanceOrderbooks.clear();
    bybitOrderbooks.clear();
  };
}

async function triggerExit(pos: GroupedPosition, ctx: AutoExitContext): Promise<void> {
  await executeCloseTrade(pos.symbol, ctx.credentials, ctx.privateWs, ctx.fetchOrderbook);
}
