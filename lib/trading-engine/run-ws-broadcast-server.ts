/**
 * Standalone WebSocket server (port 8080) that runs the trading engine
 * and broadcasts aggregated symbol state to all connected Next.js frontend clients.
 * Manual trades are executed here (EXECUTE_MANUAL_TRADE) and progress is sent via TRADE_UPDATE.
 *
 * Run: npx tsx lib/trading-engine/run-ws-broadcast-server.ts
 * Or:  npm run ws-server
 */

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
});

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { WsManager } from "./ws-manager";
import {
  PrivateWSManager,
  executeChunkTrade,
  executeCloseTrade,
  getBinanceBalance,
  getBybitBalance,
  getBinancePositions,
  getBybitPositions,
  type ExchangeCredentials,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
} from "./execution-engine";
import { startAutoExitMonitor, getDeepExitVWAPByQuantity } from "./auto-exit";
import { findUserByEmail } from "../auth-users";
import type { RawPosition } from "./execution-engine";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env") }); // Fallback

const PORT = 8080;
const BINANCE_DEPTH = "https://fapi.binance.com/fapi/v1/depth";

const SETTINGS_FILE = path.join(process.cwd(), "auto-exit-settings.json");
const SCREENER_FILTERS_FILE = path.join(process.cwd(), "screener-filters.json");

export interface ScreenerFilters {
  minL2SpreadPct?: number;
  fundingType?: "all" | "favourable";
  fundingIntervalType?: "any" | "same";
  bannedTokens?: string[];
  onlySafeOpportunities?: boolean;
}

/** Screener filters from frontend; used by auto-trade to pick same tokens as "Next". */
let screenerFilters: ScreenerFilters = loadScreenerFilters();

function loadScreenerFilters(): ScreenerFilters {
  try {
    if (fs.existsSync(SCREENER_FILTERS_FILE)) {
      const raw = fs.readFileSync(SCREENER_FILTERS_FILE, "utf-8");
      const data = JSON.parse(raw) as ScreenerFilters;
      return {
        minL2SpreadPct: typeof data.minL2SpreadPct === "number" ? data.minL2SpreadPct : 0,
        fundingType: data.fundingType === "favourable" ? "favourable" : "all",
        fundingIntervalType: data.fundingIntervalType === "same" ? "same" : "any",
        bannedTokens: Array.isArray(data.bannedTokens) ? data.bannedTokens : [],
        onlySafeOpportunities: !!data.onlySafeOpportunities,
      };
    }
  } catch (e) {
    console.warn("[WS Server] Could not load screener-filters.json:", e);
  }
  return {};
}

function saveScreenerFilters(): void {
  try {
    fs.writeFileSync(SCREENER_FILTERS_FILE, JSON.stringify(screenerFilters, null, 2), "utf-8");
  } catch (e) {
    console.error("[WS Server] Could not write screener-filters.json:", e);
  }
}

/** Mirror of frontend isFavourableFunding: net funding profit for current direction > 0 */
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

/** Mirror of frontend: filter and sort states like screener (for auto-trade candidate). */
function filterAndSortEligibleForAutoTrade(
  states: Array<{
    symbol: string;
    binanceVWAP: number | null;
    bybitVWAP: number | null;
    binanceFunding: number | null;
    bybitFunding: number | null;
    binanceFundingInterval?: number | null;
    bybitFundingInterval?: number | null;
    spreadStableMs: number;
    has3xLiquidity: boolean;
  }>,
  activeSymbols: Set<string>,
  filters: ScreenerFilters
): typeof states {
  const bannedSet = new Set((filters.bannedTokens ?? []).map((s) => String(s).toUpperCase()));
  const minSpread = typeof filters.minL2SpreadPct === "number" ? filters.minL2SpreadPct : 0;
  const fundingType = filters.fundingType === "favourable" ? "favourable" : "all";
  const fundingIntervalType = filters.fundingIntervalType === "same" ? "same" : "any";
  const onlySafe = !!filters.onlySafeOpportunities;

  return states
    .filter((s) => {
      const sym = String(s.symbol || "").toUpperCase();
      if (!sym || activeSymbols.has(sym)) return false;
      if (!s.has3xLiquidity || s.binanceVWAP == null || s.bybitVWAP == null) return false;
      if (bannedSet.has(sym)) return false;
      if (fundingIntervalType === "same") {
        if (s.binanceFundingInterval !== s.bybitFundingInterval) return false;
      }
      const l2SpreadPct = ((s.bybitVWAP - s.binanceVWAP) / s.binanceVWAP) * 100;
      if (Math.abs(l2SpreadPct) < minSpread) return false;
      if (fundingType === "favourable" && !isFavourableFunding(s.binanceVWAP, s.bybitVWAP, s.binanceFunding, s.bybitFunding)) return false;
      if (onlySafe && ((s.spreadStableMs ?? 0) < 2000 || !s.has3xLiquidity)) return false;
      return true;
    })
    .sort((a, b) => {
      const spreadA = Math.abs(((a.bybitVWAP! - a.binanceVWAP!) / a.binanceVWAP!) * 100);
      const spreadB = Math.abs(((b.bybitVWAP! - b.binanceVWAP!) / b.binanceVWAP!) * 100);
      return spreadB - spreadA;
    });
}

/** Persistent private WS for 24/7 HFT; reused across trades, never stopped. */
let privateWsManager: PrivateWSManager | null = null;

/** Last credentials used (for auto-exit monitor). Initialized from env when both API keys present. */
let lastCredentials: ExchangeCredentials | null =
  process.env.BINANCE_API_KEY && process.env.BYBIT_API_KEY
    ? {
        binance: { apiKey: process.env.BINANCE_API_KEY || "", apiSecret: process.env.BINANCE_API_SECRET || "" },
        bybit: { apiKey: process.env.BYBIT_API_KEY || "", apiSecret: process.env.BYBIT_API_SECRET || "" },
      }
    : null;

/** Prevents concurrent trades (spam clicks). */
let isTradeExecuting = false;

/** Active position symbols + symbol currently being executed; broadcast so frontend NEXT labels stay in sync. */
let cachedActivePositions: string[] = [];

/** Grouped positions with quantities for per-symbol deep exit VWAP. Updated every 3s when credentials available. */
interface CachedPositionLeg {
  quantity: number;
  side: "Long" | "Short";
}
interface CachedGroupedPosition {
  symbol: string;
  side: "Long" | "Short";
  binance: CachedPositionLeg | null;
  bybit: CachedPositionLeg | null;
}
let cachedGroupedPositions: CachedGroupedPosition[] = [];

function groupPositionsForStats(binance: RawPosition[], bybit: RawPosition[]): CachedGroupedPosition[] {
  const bySymbol = new Map<string, { binance: RawPosition | null; bybit: RawPosition | null }>();
  for (const p of binance) {
    const key = String(p.symbol || "").toUpperCase();
    if (!key) continue;
    const cur = bySymbol.get(key) ?? { binance: null, bybit: null };
    cur.binance = p;
    bySymbol.set(key, cur);
  }
  for (const p of bybit) {
    const key = String(p.symbol || "").toUpperCase();
    if (!key) continue;
    const cur = bySymbol.get(key) ?? { binance: null, bybit: null };
    cur.bybit = p;
    bySymbol.set(key, cur);
  }
  const out: CachedGroupedPosition[] = [];
  for (const [symbol, legs] of Array.from(bySymbol.entries())) {
    const b = legs.binance;
    const y = legs.bybit;
    if (!b && !y) continue;
    const side: "Long" | "Short" = b?.side ?? y?.side ?? "Long";
    out.push({
      symbol,
      side,
      binance: b ? { quantity: b.quantity, side: b.side } : null,
      bybit: y ? { quantity: y.quantity, side: y.side } : null,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function computePositionStats(
  positions: CachedGroupedPosition[],
  getBinanceOb: (sym: string) => { bids: [string, string][]; asks: [string, string][] } | null,
  getBybitOb: (sym: string) => { bids: [string, string][]; asks: [string, string][] } | null
): Record<string, { binanceExitVWAP: number; bybitExitVWAP: number }> {
  const stats: Record<string, { binanceExitVWAP: number; bybitExitVWAP: number }> = {};
  for (const pos of positions) {
    let binanceExitVWAP = 0;
    let bybitExitVWAP = 0;
    if (pos.binance) {
      const ob = getBinanceOb(pos.symbol);
      const levels = pos.binance.side === "Long" ? ob?.bids : ob?.asks;
      if (levels?.length) {
        binanceExitVWAP = getDeepExitVWAPByQuantity(levels, pos.binance.quantity * 2, pos.binance.side);
      }
    }
    if (pos.bybit) {
      const ob = getBybitOb(pos.symbol);
      const levels = pos.bybit.side === "Long" ? ob?.bids : ob?.asks;
      if (levels?.length) {
        bybitExitVWAP = getDeepExitVWAPByQuantity(levels, pos.bybit.quantity * 2, pos.bybit.side);
      }
    }
    if (binanceExitVWAP > 0 || bybitExitVWAP > 0) {
      stats[pos.symbol] = { binanceExitVWAP, bybitExitVWAP };
    }
  }
  return stats;
}

/** Dynamic settings for auto-exit (persisted to SETTINGS_PATH, read on startup). */
let autoExitSettings: Partial<ExecutionSettings> = loadAutoExitSettings();

function loadAutoExitSettings(): Partial<ExecutionSettings> {
  const defaults: Partial<ExecutionSettings> = {
    autoExit: process.env.AUTO_EXIT === "1" || process.env.AUTO_EXIT === "true",
    stoplossPercent: typeof process.env.STOPLOSS_PERCENT !== "undefined" ? parseFloat(process.env.STOPLOSS_PERCENT) || 2 : 2,
    targetPercent: typeof process.env.TARGET_PERCENT !== "undefined" ? parseFloat(process.env.TARGET_PERCENT) || 1.5 : 1.5,
    slippagePercent: typeof process.env.SLIPPAGE_PERCENT !== "undefined" ? parseFloat(process.env.SLIPPAGE_PERCENT) || 0.05 : 0.05,
    feesPercent: typeof process.env.FEES_PERCENT !== "undefined" ? parseFloat(process.env.FEES_PERCENT) || 0.1 : 0.1,
    autoTrade: false,
    maxTradeSlot: 5,
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
      const data = JSON.parse(raw) as Partial<ExecutionSettings>;
      if (typeof data.autoExit === "boolean") defaults.autoExit = data.autoExit;
      if (typeof data.stoplossPercent === "number" && data.stoplossPercent >= 0) defaults.stoplossPercent = data.stoplossPercent;
      if (typeof data.targetPercent === "number" && data.targetPercent >= 0) defaults.targetPercent = data.targetPercent;
      if (typeof data.slippagePercent === "number" && data.slippagePercent >= 0) defaults.slippagePercent = data.slippagePercent;
      if (typeof data.feesPercent === "number" && data.feesPercent >= 0) defaults.feesPercent = data.feesPercent;
      if (typeof data.autoTrade === "boolean") defaults.autoTrade = data.autoTrade;
      if (typeof data.maxTradeSlot === "number") defaults.maxTradeSlot = data.maxTradeSlot;
      if (typeof data.autoTradeUserEmail === "string" && data.autoTradeUserEmail.trim()) {
        defaults.autoTradeUserEmail = data.autoTradeUserEmail.trim();
      }
    }
  } catch (e) {
    console.warn("[WS Server] Could not load auto-exit-settings.json:", e);
  }
  console.log("[WS Server] Auto-Exit settings loaded: autoExit=" + defaults.autoExit + " autoTrade=" + defaults.autoTrade + (defaults.autoTradeUserEmail ? " autoTradeUser=" + defaults.autoTradeUserEmail : ""));
  return defaults;
}

function saveAutoExitSettings(): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(autoExitSettings, null, 2), "utf-8");
  } catch (e) {
    console.error("[WS Server] Could not write auto-exit-settings.json:", e);
  }
}

const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  capitalPercent: 10,
  minChunkNotional: 6,
  bybitToBinanceDelayMs: 10,
  chunkLiquidityFraction: 0.5,
  slippagePercent: 0.05,
  feesPercent: 0.1,
};

async function fetchOrderbookSnapshot(symbol: string): Promise<OrderbookSnapshot> {
  const res = await fetch(`${BINANCE_DEPTH}?symbol=${symbol}&limit=20`);
  if (!res.ok) throw new Error(`Orderbook fetch: ${res.status}`);
  const data = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
  return {
    symbol,
    bids: data.bids ?? [],
    asks: data.asks ?? [],
  };
}

const wss = new WebSocketServer({ port: PORT });
const clients = new Set<import("ws").WebSocket>();

function broadcast(payload: unknown) {
  const data = JSON.stringify(payload);
  clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(data);
      } catch (e) {
        console.error("[WS Server] Send error:", e);
      }
    }
  });
}

function sendTradeUpdate(
  ws: import("ws").WebSocket,
  status: string,
  done?: boolean
) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ action: "TRADE_UPDATE", status, done }));
  } catch (e) {
    console.error("[WS Server] TRADE_UPDATE send error:", e);
  }
}

async function runManualTrade(
  ws: import("ws").WebSocket,
  payload: {
    symbol: string;
    side: string;
    isExit?: boolean;
    quantity?: number;
    userEmail?: string;
  }
) {
  isTradeExecuting = true;
  try {
    const { symbol, side, isExit, quantity, userEmail } = payload;
    if (!userEmail?.trim()) {
      isTradeExecuting = false;
      sendTradeUpdate(ws, "Trade failed: Not authenticated", true);
      return;
    }
    const user = findUserByEmail(userEmail.trim());
    if (!user?.apiKeys?.binanceApiKey || !user?.apiKeys?.binanceApiSecret || !user?.apiKeys?.bybitApiKey || !user?.apiKeys?.bybitApiSecret) {
      isTradeExecuting = false;
      sendTradeUpdate(ws, "Trade failed: API keys not configured. Save them in Settings.", true);
      return;
    }
    const credentials: ExchangeCredentials = {
      binance: {
        apiKey: user.apiKeys.binanceApiKey,
        apiSecret: user.apiKeys.binanceApiSecret,
      },
      bybit: {
        apiKey: user.apiKeys.bybitApiKey,
        apiSecret: user.apiKeys.bybitApiSecret,
      },
    };
    (credentials as { slippagePercent?: number }).slippagePercent = autoExitSettings.slippagePercent ?? 0.05;
    (credentials as { feesPercent?: number }).feesPercent = autoExitSettings.feesPercent ?? 0.1;
    lastCredentials = credentials;

    console.log("[CHUNK-SYSTEM] Manual trade requested via WS: symbol=" + symbol + " side=" + side + " isExit=" + !!isExit);

    const isCloseFlow = !!isExit;

    if (!privateWsManager || !privateWsManager.isConnected()) {
      if (privateWsManager) {
        console.log("[CHUNK-SYSTEM] Private WS disconnected; stopping before reconnecting.");
        privateWsManager.stop();
        privateWsManager = null;
      }
      console.log("[CHUNK-SYSTEM] Private WS not connected; creating and starting persistent connection.");
      privateWsManager = new PrivateWSManager(credentials);
      await privateWsManager.start();
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (isCloseFlow) {
      sendTradeUpdate(ws, "Exiting…");
      const ok = await executeCloseTrade(symbol, credentials, privateWsManager, fetchOrderbookSnapshot, (msg) => sendTradeUpdate(ws, msg), userEmail);
      if (ok) {
        sendTradeUpdate(ws, "Trade completed", true);
      } else {
        sendTradeUpdate(ws, "Trade failed: exit did not complete fully", true);
      }
      return;
    }

    const symUpper = String(symbol || "").toUpperCase();
    if (symUpper) cachedActivePositions = Array.from(new Set([...cachedActivePositions, symUpper]));

    const [orderbook, binanceData, bybitData] = await Promise.all([
      fetchOrderbookSnapshot(symbol),
      getBinanceBalance(credentials.binance.apiKey, credentials.binance.apiSecret),
      getBybitBalance(credentials.bybit.apiKey, credentials.bybit.apiSecret),
    ]);
    const binanceBalance = binanceData.available;
    const bybitBalance = bybitData.available;
    const bestAsk = orderbook.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : 0;
    const bestBid = orderbook.bids[0]?.[0] ? parseFloat(orderbook.bids[0][0]) : 0;
    const binanceL2 = side === "Long" ? bestAsk : bestBid;
    const bybitL2 = binanceL2;

    const settings = { ...DEFAULT_EXECUTION_SETTINGS, ...autoExitSettings, manualQuantity: quantity };
    try {
      const results = await executeChunkTrade(
        symbol,
        side as OrderSide,
        orderbook,
        settings,
        credentials,
        privateWsManager,
        binanceBalance,
        bybitBalance,
        binanceL2,
        bybitL2,
        (msg) => {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ action: "TRADE_UPDATE", status: msg }));
          } catch {}
        },
        isExit
      );
      const success = results.length > 0 && results.some((r) => r.success);
      if (success) {
        sendTradeUpdate(ws, "Trade execution cycle complete", true);
      } else {
        const err = results[0]?.error ?? "Execution failed";
        sendTradeUpdate(ws, `Trade failed: ${err}`, true);
      }
    } catch (tradeErr) {
      const errMsg = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
      console.error("[WS Server] [CHUNK-SYSTEM] Manual trade execution error:", errMsg);
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ action: "TRADE_UPDATE", status: `Trade failed: ${errMsg}`, done: true }));
      } catch {}
    } finally {
      isTradeExecuting = false;
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[WS Server] [CHUNK-SYSTEM] runManualTrade error:", errMsg);
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ action: "TRADE_UPDATE", status: `Trade failed: ${errMsg}`, done: true }));
    } catch (sendErr) {
      console.error("[WS Server] sendTradeUpdate after error:", sendErr);
    }
    isTradeExecuting = false;
  } finally {
    isTradeExecuting = false;
  }
}

async function main() {
  const manager = new WsManager({
    vwapTargetAmount: 10_000,
    maxSymbols: 50,
    onStateUpdate(states) {
      const positionStats = computePositionStats(
        cachedGroupedPositions,
        (sym) => manager.getLiveOrderbook(sym),
        (sym) => manager.getBybitLiveOrderbook(sym)
      );
      broadcast({
        type: "state",
        states,
        ts: Date.now(),
        maxTradeSlot: autoExitSettings.maxTradeSlot,
        activePositions: [...cachedActivePositions],
        positionStats,
      });
    },
  });

  const symbols = await manager.start();
  console.log(`[WS Server] Listening on ws://0.0.0.0:${PORT}`);

  // Keep cached grouped positions (with quantities) up to date for positionStats deep exit VWAP.
  setInterval(async () => {
    if (!lastCredentials) return;
    try {
      const [binancePositions, bybitPositions] = await Promise.all([
        getBinancePositions(lastCredentials.binance.apiKey, lastCredentials.binance.apiSecret).catch(() => []),
        getBybitPositions(lastCredentials.bybit.apiKey, lastCredentials.bybit.apiSecret).catch(() => []),
      ]);
      cachedGroupedPositions = groupPositionsForStats(binancePositions, bybitPositions);
    } catch {
      // ignore
    }
  }, 3000);
  console.log(`[WS Server] Tracking ${symbols.length} symbols: ${symbols.slice(0, 8).join(", ")}${symbols.length > 8 ? "..." : ""}`);

  const getSettings = (): ExecutionSettings => ({ ...DEFAULT_EXECUTION_SETTINGS, ...autoExitSettings });
  const getContext = () => {
    if (!lastCredentials) return null;
    if (!privateWsManager || !privateWsManager.isConnected()) {
      console.log("[CHUNK-SYSTEM] Auto-Exit: Private WS disconnected. Reconnecting...");
      if (privateWsManager) privateWsManager.stop();
      privateWsManager = new PrivateWSManager(lastCredentials);
      privateWsManager.start().catch((e) => console.error("[WS Server] Reconnect error:", e));
      return null; // Skip this 3s tick while reconnecting
    }
    return {
      credentials: lastCredentials,
      privateWs: privateWsManager,
      fetchOrderbook: fetchOrderbookSnapshot,
      getLiveOrderbook: (sym: string) => manager.getLiveOrderbook(sym),
      defaultSettings: getSettings(),
    };
  };
  startAutoExitMonitor(getSettings, getContext);
  console.log(`[WS Server] Auto-Exit monitor started (autoExit=${!!autoExitSettings.autoExit}).`);

  if (lastCredentials) {
    console.log("[WS Server] Found API keys in ENV. Auto-starting Private WS Manager...");
    privateWsManager = new PrivateWSManager(lastCredentials);
    await privateWsManager.start();
  }

  let isAutoTradeRunning = false;
  setInterval(async () => {
    if (!autoExitSettings.autoTrade || isTradeExecuting || isAutoTradeRunning) return;

    let creds = lastCredentials;
    const autoTradeEmail = autoExitSettings.autoTradeUserEmail?.trim();
    if (!creds && autoTradeEmail) {
      const user = findUserByEmail(autoTradeEmail);
      if (user?.apiKeys?.binanceApiKey && user?.apiKeys?.binanceApiSecret && user?.apiKeys?.bybitApiKey && user?.apiKeys?.bybitApiSecret) {
        creds = {
          binance: { apiKey: user.apiKeys.binanceApiKey, apiSecret: user.apiKeys.binanceApiSecret },
          bybit: { apiKey: user.apiKeys.bybitApiKey, apiSecret: user.apiKeys.bybitApiSecret },
        };
        (creds as { slippagePercent?: number }).slippagePercent = autoExitSettings.slippagePercent ?? 0.05;
        (creds as { feesPercent?: number }).feesPercent = autoExitSettings.feesPercent ?? 0.1;
        lastCredentials = creds;
        if (!privateWsManager || !privateWsManager.isConnected()) {
          if (privateWsManager) privateWsManager.stop();
          privateWsManager = new PrivateWSManager(creds);
          await privateWsManager.start().catch((e) => console.error("[WS Server] Auto-trade Private WS start error:", e));
        }
        console.log("[AUTO-TRADE] Using API keys for " + autoTradeEmail + " (from Save settings).");
      }
    }
    if (!creds) {
      if (autoExitSettings.autoTrade && !lastCredentials) {
        console.log("[AUTO-TRADE] Skipped: no API credentials. Save API keys in Settings and click Save settings (or run one manual trade).");
      }
      return;
    }
    if (!privateWsManager || !privateWsManager.isConnected()) {
      console.log("[AUTO-TRADE] Skipped: private WS not connected.");
      return;
    }

    isAutoTradeRunning = true;
    try {
      const [binancePositions, bybitPositions] = await Promise.all([
        getBinancePositions(creds.binance.apiKey, creds.binance.apiSecret).catch(() => []),
        getBybitPositions(creds.bybit.apiKey, creds.bybit.apiSecret).catch(() => []),
      ]);

      const activeSymbols = new Set([
        ...binancePositions.map((p) => p.symbol),
        ...bybitPositions.map((p) => p.symbol),
      ]);
      cachedActivePositions = Array.from(activeSymbols);
      const maxSlots = autoExitSettings.maxTradeSlot ?? 5;

      if (activeSymbols.size >= maxSlots) {
        isAutoTradeRunning = false;
        return;
      }

      // 2. Screener Logic: Use same filters as frontend (min spread, favourable funding, banned, only safe)
      const states = manager.getStates();
      const eligibleTokens = filterAndSortEligibleForAutoTrade(states, activeSymbols, screenerFilters);

      if (eligibleTokens.length === 0) {
        console.log("[AUTO-TRADE] No eligible tokens (slots " + activeSymbols.size + "/" + maxSlots + "). Filters or market may exclude all.");
      }

      if (eligibleTokens.length > 0) {
        const topToken = eligibleTokens[0].symbol;
        console.log(`[AUTO-TRADE] Empty slot found (${activeSymbols.size}/${maxSlots}). Initiating trade for Top Token: ${topToken}`);

        cachedActivePositions = Array.from(new Set([...cachedActivePositions, topToken]));
        isTradeExecuting = true;
        try {
          const orderbook = await fetchOrderbookSnapshot(topToken);
          const binanceData = await getBinanceBalance(creds.binance.apiKey, creds.binance.apiSecret);
          const bybitData = await getBybitBalance(creds.bybit.apiKey, creds.bybit.apiSecret);
          const bestAsk = orderbook.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : 0;

          const settings = { ...DEFAULT_EXECUTION_SETTINGS, ...autoExitSettings, manualQuantity: undefined };

          // Determine the correct arbitrage direction based on L2 prices
          const topState = eligibleTokens[0];
          const l2SpreadPct = ((topState.bybitVWAP! - topState.binanceVWAP!) / topState.binanceVWAP!) * 100;
          const autoSide = l2SpreadPct > 0 ? "Long Binance / Short Bybit" : "Long Bybit / Short Binance";

          await executeChunkTrade(
            topToken,
            autoSide as OrderSide,
            orderbook,
            settings,
            creds,
            privateWsManager,
            binanceData.available,
            bybitData.available,
            bestAsk,
            bestAsk,
            (msg) => console.log(`[AUTO-TRADE] ${msg}`)
          );
        } finally {
          isTradeExecuting = false;
        }
      }
    } catch (err) {
      console.error("[AUTO-TRADE] Error:", err);
    } finally {
      isAutoTradeRunning = false;
    }
  }, 10000);

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[WS Server] Client connected. Total: ${clients.size}`);

    // Send current state immediately (include positionStats for precise exit VWAP PnL).
    const states = manager.getStates();
    const positionStats = computePositionStats(
      cachedGroupedPositions,
      (sym) => manager.getLiveOrderbook(sym),
      (sym) => manager.getBybitLiveOrderbook(sym)
    );
    try {
      ws.send(
        JSON.stringify({
          type: "state",
          states,
          ts: Date.now(),
          maxTradeSlot: autoExitSettings.maxTradeSlot,
          activePositions: [...cachedActivePositions],
          positionStats,
        })
      );
    } catch (e) {
      console.error("[WS Server] Initial send error:", e);
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          action?: string;
          amount?: unknown;
          payload?: {
            symbol?: string;
            side?: string;
            binanceApiKey?: string;
            binanceApiSecret?: string;
            bybitApiKey?: string;
            bybitApiSecret?: string;
          };
        };
        if (msg.action === "set_trade_amount") {
          const amount = Number(msg.amount);
          if (Number.isFinite(amount) && amount > 0) {
            manager.setVwapTargetAmount(amount);
          }
          return;
        }
        if (msg.action === "update_screener_filters") {
          const filtersPayload = (msg as { filters?: ScreenerFilters }).filters;
          if (filtersPayload && typeof filtersPayload === "object") {
            screenerFilters = {
              minL2SpreadPct: typeof filtersPayload.minL2SpreadPct === "number" ? filtersPayload.minL2SpreadPct : 0,
              fundingType: filtersPayload.fundingType === "favourable" ? "favourable" : "all",
              fundingIntervalType: filtersPayload.fundingIntervalType === "same" ? "same" : "any",
              bannedTokens: Array.isArray(filtersPayload.bannedTokens) ? filtersPayload.bannedTokens : [],
              onlySafeOpportunities: !!filtersPayload.onlySafeOpportunities,
            };
            saveScreenerFilters();
            console.log("[WS Server] Screener filters updated: minL2SpreadPct=" + screenerFilters.minL2SpreadPct + " fundingType=" + screenerFilters.fundingType + " banned=" + (screenerFilters.bannedTokens?.length ?? 0) + " onlySafe=" + screenerFilters.onlySafeOpportunities);
          }
          return;
        }
        const payloadMsg = msg.payload as { autoExit?: boolean; stoplossPercent?: number; targetPercent?: number; slippagePercent?: number; feesPercent?: number; leverage?: number; capitalPercent?: number; autoTrade?: boolean; maxTradeSlot?: number; userEmail?: string } | undefined;
        if (msg.action === "set_auto_exit_settings" && payloadMsg) {
          if (typeof payloadMsg.autoExit === "boolean") autoExitSettings.autoExit = payloadMsg.autoExit;
          if (typeof payloadMsg.stoplossPercent === "number" && payloadMsg.stoplossPercent >= 0) autoExitSettings.stoplossPercent = payloadMsg.stoplossPercent;
          if (typeof payloadMsg.targetPercent === "number" && payloadMsg.targetPercent >= 0) autoExitSettings.targetPercent = payloadMsg.targetPercent;
          if (typeof payloadMsg.slippagePercent === "number" && payloadMsg.slippagePercent >= 0) autoExitSettings.slippagePercent = payloadMsg.slippagePercent;
          if (typeof payloadMsg.feesPercent === "number" && payloadMsg.feesPercent >= 0) autoExitSettings.feesPercent = payloadMsg.feesPercent;
          if (typeof payloadMsg.leverage === "number") autoExitSettings.leverage = payloadMsg.leverage;
          if (typeof payloadMsg.capitalPercent === "number") autoExitSettings.capitalPercent = payloadMsg.capitalPercent;
          if (typeof payloadMsg.autoTrade === "boolean") autoExitSettings.autoTrade = payloadMsg.autoTrade;
          if (typeof payloadMsg.maxTradeSlot === "number") autoExitSettings.maxTradeSlot = payloadMsg.maxTradeSlot;
          if (typeof payloadMsg.userEmail === "string" && payloadMsg.userEmail.trim()) {
            autoExitSettings.autoTradeUserEmail = payloadMsg.userEmail.trim();
          }
          saveAutoExitSettings();
          console.log("[WS Server] Auto-Exit settings updated from client: autoExit=" + autoExitSettings.autoExit + " autoTrade=" + autoExitSettings.autoTrade + (autoExitSettings.autoTradeUserEmail ? " autoTradeUser=" + autoExitSettings.autoTradeUserEmail : ""));
          return;
        }
        if (msg.action === "EXECUTE_MANUAL_TRADE") {
          if (isTradeExecuting) {
            sendTradeUpdate(ws, "Trade in progress, please wait", true);
            return;
          }
          const payload = msg.payload as {
            symbol?: string;
            side?: string;
            isExit?: boolean;
            quantity?: number;
            leverage?: number;
            userEmail?: string;
          } | undefined;
          if (
            !payload?.symbol ||
            !payload.side ||
            typeof payload.side !== "string" ||
            payload.side.trim() === ""
          ) {
            sendTradeUpdate(ws, "Trade failed: Invalid symbol or side", true);
            return;
          }
          if (!payload.userEmail?.trim()) {
            sendTradeUpdate(ws, "Trade failed: Not authenticated", true);
            return;
          }
          runManualTrade(ws, {
            symbol: payload.symbol,
            side: payload.side,
            isExit: payload.isExit,
            quantity: payload.quantity,
            userEmail: payload.userEmail,
          }).catch((e) => {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.error("[WS Server] [CHUNK-SYSTEM] Manual trade error:", errMsg);
            sendTradeUpdate(ws, `Trade failed: ${errMsg}`, true);
          });
          return;
        }
      } catch (err) {
        console.error("[WS Server] Message parse error:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[WS Server] Client disconnected. Total: ${clients.size}`);
    });
    ws.on("error", () => clients.delete(ws));
  });

  process.on("SIGINT", () => {
    manager.stop();
    wss.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("[WS Server] Fatal:", e);
  process.exit(1);
});
