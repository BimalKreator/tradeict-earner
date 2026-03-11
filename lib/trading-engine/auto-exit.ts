/**
 * Phase 3.6: Auto-Exit Engine.
 * Monitors positions for stoploss/take-profit (combined PnL vs L2) and orphan exit (>30s).
 */

import {
  getBinancePositions,
  getBybitPositions,
  executeChunkTrade,
  getBinanceBalance,
  getBybitBalance,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
  type RawPosition,
  type ExchangeCredentials,
  type PrivateWSManager,
} from "./execution-engine";

const CHECK_INTERVAL_MS = 3000;
const ORPHAN_EXIT_THRESHOLD_MS = 30_000;
const MAX_ORDERBOOK_CACHE = 50;

let autoExitIntervalId: ReturnType<typeof setInterval> | null = null;

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

/** Combined PnL using L2 from orderbook as mark (do not use exchange PnL). */
function combinedPnlFromL2(
  pos: GroupedPosition,
  orderbook: OrderbookSnapshot | undefined
): number {
  const bestAsk = orderbook?.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : null;
  const bestBid = orderbook?.bids[0]?.[0] ? parseFloat(orderbook.bids[0][0]) : null;
  const mark = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid ?? 0);
  if (mark <= 0) return 0;

  let pnl = 0;
  if (pos.binance) {
    const b = pos.binance;
    pnl += b.side === "Long" ? (mark - b.entryPrice) * b.quantity : (b.entryPrice - mark) * b.quantity;
  }
  if (pos.bybit) {
    const y = pos.bybit;
    pnl += y.side === "Long" ? (mark - y.entryPrice) * y.quantity : (y.entryPrice - mark) * y.quantity;
  }
  return pnl;
}

export interface AutoExitContext {
  credentials: ExchangeCredentials;
  privateWs: PrivateWSManager;
  fetchOrderbook: (symbol: string) => Promise<OrderbookSnapshot>;
  defaultSettings: ExecutionSettings;
}

/**
 * Starts the auto-exit monitor. Runs every 3s.
 * - If !settings.autoExit, skips.
 * - Fetches positions, builds orderbook map via context.fetchOrderbook, computes combined PnL from L2.
 * - SL/TP: if combinedPnl <= -StoplossAmount or >= TargetAmount, triggers exit.
 * - Orphan: if position on one exchange only for > 30s, triggers exit.
 */
export function startAutoExitMonitor(
  getSettings: () => ExecutionSettings,
  getOrderbooks: () => Map<string, OrderbookSnapshot>,
  getContext: () => AutoExitContext | null
): () => void {
  if (autoExitIntervalId != null) {
    clearInterval(autoExitIntervalId);
    autoExitIntervalId = null;
  }
  const exitLocks = new Set<string>();
  const orphanFirstSeen = new Map<string, number>();

  autoExitIntervalId = setInterval(async () => {
    const settings = getSettings();
    if (!settings.autoExit) return;

    const ctx = getContext();
    if (!ctx) return;

    const { credentials, privateWs, fetchOrderbook, defaultSettings } = ctx;
    const orderbooks = getOrderbooks();

    try {
      const [binanceList, bybitList] = await Promise.all([
        getBinancePositions(credentials.binance.apiKey, credentials.binance.apiSecret),
        getBybitPositions(credentials.bybit.apiKey, credentials.bybit.apiSecret),
      ]);
      const activeBinance = binanceList.filter((p) => p.quantity > 0);
      const activeBybit = bybitList.filter((p) => p.quantity > 0);
      const positions = groupPositions(activeBinance, activeBybit);

      for (const pos of positions) {
        if (!orderbooks.has(pos.symbol)) {
          try {
            orderbooks.set(pos.symbol, await fetchOrderbook(pos.symbol));
          } catch {
            // skip symbol if orderbook fetch fails
          }
        }
      }
      if (orderbooks.size > MAX_ORDERBOOK_CACHE) {
        const keys = Array.from(orderbooks.keys());
        for (let i = 0; i < keys.length - MAX_ORDERBOOK_CACHE; i++) orderbooks.delete(keys[i]);
      }

      const stoplossPct = (settings.stoplossPercent ?? 2) / 100;
      const targetPct = (settings.targetPercent ?? 1.5) / 100;

      for (const pos of positions) {
        if (exitLocks.has(pos.symbol)) continue;

        const orderbook = orderbooks.get(pos.symbol) ?? undefined;
        const combinedPnl = combinedPnlFromL2(pos, orderbook);
        const stoplossAmount = pos.usedMargin * stoplossPct;
        const targetAmount = pos.usedMargin * targetPct;

        const isOrphan = !pos.binance || !pos.bybit;
        if (isOrphan) {
          const now = Date.now();
          const firstSeen = orphanFirstSeen.get(pos.symbol);
          if (firstSeen == null) orphanFirstSeen.set(pos.symbol, now);
          else if (now - firstSeen > ORPHAN_EXIT_THRESHOLD_MS) {
            orphanFirstSeen.delete(pos.symbol);
            exitLocks.add(pos.symbol);
            console.log(`[CHUNK-SYSTEM] Auto-Exit: orphan ${pos.symbol} (one leg > 30s). Triggering exit.`);
            triggerExit(pos, ctx, defaultSettings).finally(() => exitLocks.delete(pos.symbol));
          }
          continue;
        }
        orphanFirstSeen.delete(pos.symbol);

        if (combinedPnl <= -stoplossAmount || combinedPnl >= targetAmount) {
          exitLocks.add(pos.symbol);
          const reason = combinedPnl <= -stoplossAmount ? "stoploss" : "target";
          console.log(`[CHUNK-SYSTEM] Auto-Exit: ${pos.symbol} ${reason} (PnL=$${combinedPnl.toFixed(2)}). Triggering exit.`);
          triggerExit(pos, ctx, defaultSettings).finally(() => exitLocks.delete(pos.symbol));
        }
      }
    } catch (e) {
      console.error("[CHUNK-SYSTEM] Auto-Exit monitor error:", e);
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    if (autoExitIntervalId != null) {
      clearInterval(autoExitIntervalId);
      autoExitIntervalId = null;
    }
  };
}

async function triggerExit(
  pos: GroupedPosition,
  ctx: AutoExitContext,
  defaultSettings: ExecutionSettings
): Promise<void> {
  const { credentials, privateWs, fetchOrderbook } = ctx;
  const orderbook = await fetchOrderbook(pos.symbol);
  const [binanceData, bybitData] = await Promise.all([
    getBinanceBalance(credentials.binance.apiKey, credentials.binance.apiSecret),
    getBybitBalance(credentials.bybit.apiKey, credentials.bybit.apiSecret),
  ]);
  const bestAsk = orderbook.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : 0;
  const bestBid = orderbook.bids[0]?.[0] ? parseFloat(orderbook.bids[0][0]) : 0;
  const closeSide: OrderSide = pos.side === "Long" ? "Short" : "Long";
  const l2 = closeSide === "Long" ? bestAsk : bestBid;

  await executeChunkTrade(
    pos.symbol,
    closeSide,
    orderbook,
    defaultSettings,
    credentials,
    privateWs,
    binanceData.available,
    bybitData.available,
    l2,
    l2,
    undefined,
    true
  );
}
