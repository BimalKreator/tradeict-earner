/**
 * Phase 3.6: Auto-Exit Engine.
 * Monitors positions for stoploss/take-profit (combined PnL vs L2) and orphan exit (>30s).
 */

import {
  getBinancePositions,
  getBybitPositions,
  executeCloseTrade,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
  type RawPosition,
  type ExchangeCredentials,
  type PrivateWSManager,
} from "./execution-engine";

const ORPHAN_EXIT_THRESHOLD_MS = 30_000;

let cachedPositions: GroupedPosition[] = [];
let isFetchingPositions = false;
let posIntervalId: ReturnType<typeof setInterval> | null = null;
let priceIntervalId: ReturnType<typeof setInterval> | null = null;

interface GroupedPosition {
  symbol: string;
  side: OrderSide;
  binance: RawPosition | null;
  bybit: RawPosition | null;
  totalQuantity: number;
  entryPrice: number;
  usedMargin: number;
}

function normalizeSymbol(s: string): string {
  return (s || "").toUpperCase();
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

export interface AutoExitContext {
  credentials: ExchangeCredentials;
  privateWs: PrivateWSManager;
  fetchOrderbook: (symbol: string) => Promise<OrderbookSnapshot>;
  getLiveOrderbook: (symbol: string) => OrderbookSnapshot | null;
  defaultSettings: ExecutionSettings;
}

/**
 * Dual-loop Auto-Exit: position poller (3s, avoids rate limits) + HFT price monitor (200ms, live WS orderbook).
 */
export function startAutoExitMonitor(
  getSettings: () => ExecutionSettings,
  getContext: () => AutoExitContext | null
): () => void {
  if (posIntervalId) clearInterval(posIntervalId);
  if (priceIntervalId) clearInterval(priceIntervalId);
  const exitLocks = new Set<string>();
  const orphanFirstSeen = new Map<string, number>();

  // Loop 1: Position Poller (Every 3s) - Avoids API Rate Limits
  posIntervalId = setInterval(async () => {
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
      cachedPositions = groupPositions(
        binanceList.filter((p) => p.quantity > 0),
        bybitList.filter((p) => p.quantity > 0)
      );
    } catch {
      // suppress position fetch errors to avoid log spam
    } finally {
      isFetchingPositions = false;
    }
  }, 3000);

  // Loop 2: HFT Price Monitor (Every 200ms) - Reads RAM Orderbook 0ms delay
  priceIntervalId = setInterval(() => {
    const settings = getSettings();
    if (!settings.autoExit) return;
    const ctx = getContext();
    if (!ctx) return;
    const stoplossPct = (settings.stoplossPercent ?? 2) / 100;
    const targetPct = (settings.targetPercent ?? 1.5) / 100;

    for (const pos of cachedPositions) {
      if (exitLocks.has(pos.symbol)) continue;

      // 1. Orphan Check
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

      // 2. Ultra-Fast L2 VWAP PnL Check
      const liveOrderbook = ctx.getLiveOrderbook(pos.symbol);
      if (!liveOrderbook || liveOrderbook.asks.length === 0 || liveOrderbook.bids.length === 0) continue;
      const combinedPnl = combinedPnlFromL2(pos, liveOrderbook);
      const stoplossAmount = pos.usedMargin * stoplossPct;
      const targetAmount = pos.usedMargin * targetPct;
      if (combinedPnl <= -stoplossAmount || combinedPnl >= targetAmount) {
        exitLocks.add(pos.symbol);
        const reason = combinedPnl <= -stoplossAmount ? "stoploss" : "target";
        console.log(`[CHUNK-SYSTEM] Auto-Exit: ${pos.symbol} ${reason} (PnL=$${combinedPnl.toFixed(2)}). Triggering exit.`);
        triggerExit(pos, ctx).finally(() => exitLocks.delete(pos.symbol));
      }
    }
  }, 200);

  return () => {
    if (posIntervalId) clearInterval(posIntervalId);
    if (priceIntervalId) clearInterval(priceIntervalId);
    posIntervalId = null;
    priceIntervalId = null;
  };
}

async function triggerExit(pos: GroupedPosition, ctx: AutoExitContext): Promise<void> {
  await executeCloseTrade(pos.symbol, ctx.credentials, ctx.privateWs, ctx.fetchOrderbook);
}
