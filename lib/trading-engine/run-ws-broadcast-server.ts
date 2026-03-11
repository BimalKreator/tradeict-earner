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

import { WebSocketServer } from "ws";
import { WsManager } from "./ws-manager";
import {
  PrivateWSManager,
  executeChunkTrade,
  executeCloseTrade,
  getBinanceBalance,
  getBybitBalance,
  type ExchangeCredentials,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
} from "./execution-engine";
import { startAutoExitMonitor } from "./auto-exit";

const PORT = 8080;
const BINANCE_DEPTH = "https://fapi.binance.com/fapi/v1/depth";

/** Persistent private WS for 24/7 HFT; reused across trades, never stopped. */
let privateWsManager: PrivateWSManager | null = null;

/** Last credentials used (for auto-exit monitor). */
let lastCredentials: ExchangeCredentials | null = null;

/** Prevents concurrent trades (spam clicks). */
let isTradeExecuting = false;

/** Dynamic settings for auto-exit (read in real-time by monitor). */
const autoExitSettings: Partial<ExecutionSettings> = {
  autoExit: process.env.AUTO_EXIT === "1" || process.env.AUTO_EXIT === "true",
  stoplossPercent: typeof process.env.STOPLOSS_PERCENT !== "undefined" ? parseFloat(process.env.STOPLOSS_PERCENT) || 2 : 2,
  targetPercent: typeof process.env.TARGET_PERCENT !== "undefined" ? parseFloat(process.env.TARGET_PERCENT) || 1.5 : 1.5,
};

const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  capitalPercent: 10,
  minChunkNotional: 6,
  bybitToBinanceDelayMs: 10,
  chunkLiquidityFraction: 0.5,
};

/** Orderbook cache for auto-exit (monitor fills per position symbol). */
const orderbookCache = new Map<string, OrderbookSnapshot>();

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
    binanceApiKey: string;
    binanceApiSecret: string;
    bybitApiKey: string;
    bybitApiSecret: string;
    isExit?: boolean;
    quantity?: number;
  }
) {
  isTradeExecuting = true;
  try {
    const { symbol, side, isExit, quantity } = payload;
    const credentials: ExchangeCredentials = {
      binance: {
        apiKey: payload.binanceApiKey,
        apiSecret: payload.binanceApiSecret,
      },
      bybit: {
        apiKey: payload.bybitApiKey,
        apiSecret: payload.bybitApiSecret,
      },
    };
    lastCredentials = credentials;

    console.log("[CHUNK-SYSTEM] Manual trade requested via WS: symbol=" + symbol + " side=" + side + " isExit=" + !!isExit);

    const isCloseFlow = !!isExit && typeof quantity === "number" && quantity > 0;
    let orderbook: OrderbookSnapshot;
    let binanceBalance: number;
    let bybitBalance: number;
    let binanceL2: number;
    let bybitL2: number;

    if (isCloseFlow) {
      orderbook = await fetchOrderbookSnapshot(symbol);
      binanceBalance = 0;
      bybitBalance = 0;
      const bestAsk = orderbook.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : 0;
      const bestBid = orderbook.bids[0]?.[0] ? parseFloat(orderbook.bids[0][0]) : 0;
      const closeSide = side === "Long" ? "Short" : "Long";
      binanceL2 = closeSide === "Long" ? bestAsk : bestBid;
      bybitL2 = binanceL2;
    } else {
      const [ob, binanceData, bybitData] = await Promise.all([
        fetchOrderbookSnapshot(symbol),
        getBinanceBalance(payload.binanceApiKey, payload.binanceApiSecret),
        getBybitBalance(payload.bybitApiKey, payload.bybitApiSecret),
      ]);
      orderbook = ob;
      binanceBalance = binanceData.available;
      bybitBalance = bybitData.available;
      const bestAsk = orderbook.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : 0;
      const bestBid = orderbook.bids[0]?.[0] ? parseFloat(orderbook.bids[0][0]) : 0;
      binanceL2 = side === "Long" ? bestAsk : bestBid;
      bybitL2 = binanceL2;
    }

    if (!privateWsManager || !privateWsManager.isConnected()) {
      console.log("[CHUNK-SYSTEM] Private WS not connected; creating and starting persistent connection.");
      privateWsManager = new PrivateWSManager(credentials);
      await privateWsManager.start();
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (isCloseFlow) {
      sendTradeUpdate(ws, "Exiting…");
      const positionSide = (side === "Short" ? "Long" : "Short") as OrderSide;
      const result = await executeCloseTrade(
        symbol,
        positionSide,
        quantity!,
        orderbook,
        credentials,
        privateWsManager
      );
      if (result.success) {
        sendTradeUpdate(ws, "Trade completed", true);
      } else {
        sendTradeUpdate(ws, `Trade failed: ${result.error ?? "Execution failed"}`, true);
      }
      return;
    }

    const results = await executeChunkTrade(
      symbol,
      side as OrderSide,
      orderbook,
      DEFAULT_EXECUTION_SETTINGS,
      credentials,
      privateWsManager,
      binanceBalance,
      bybitBalance,
      binanceL2,
      bybitL2,
      (message) => sendTradeUpdate(ws, message),
      isExit
    );
    const success = results.length > 0 && results.some((r) => r.success);
    if (success) {
      sendTradeUpdate(ws, "Trade completed", true);
    } else {
      const err = results[0]?.error ?? "Execution failed";
      sendTradeUpdate(ws, `Trade failed: ${err}`, true);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[WS Server] [CHUNK-SYSTEM] runManualTrade error:", errMsg);
    try {
      sendTradeUpdate(ws, `Trade failed: ${errMsg}`, true);
    } catch (sendErr) {
      console.error("[WS Server] sendTradeUpdate after error:", sendErr);
    }
  } finally {
    isTradeExecuting = false;
  }
}

async function main() {
  const manager = new WsManager({
    vwapTargetAmount: 10_000,
    maxSymbols: 50,
    onStateUpdate(states) {
      broadcast({ type: "state", states, ts: Date.now() });
    },
  });

  const symbols = await manager.start();
  console.log(`[WS Server] Listening on ws://0.0.0.0:${PORT}`);
  console.log(`[WS Server] Tracking ${symbols.length} symbols: ${symbols.slice(0, 8).join(", ")}${symbols.length > 8 ? "..." : ""}`);

  const getSettings = (): ExecutionSettings => ({ ...DEFAULT_EXECUTION_SETTINGS, ...autoExitSettings });
  const getOrderbooks = (): Map<string, OrderbookSnapshot> => orderbookCache;
  const getContext = () => {
    if (!privateWsManager || !lastCredentials || !privateWsManager.isConnected()) return null;
    return {
      credentials: lastCredentials,
      privateWs: privateWsManager,
      fetchOrderbook: fetchOrderbookSnapshot,
      defaultSettings: getSettings(),
    };
  };
  startAutoExitMonitor(getSettings, getOrderbooks, getContext);
  console.log(`[WS Server] Auto-Exit monitor started (autoExit=${!!autoExitSettings.autoExit}).`);

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[WS Server] Client connected. Total: ${clients.size}`);

    // Send current state immediately
    const states = manager.getStates();
    try {
      ws.send(JSON.stringify({ type: "state", states, ts: Date.now() }));
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
        const payloadMsg = msg.payload as { autoExit?: boolean; stoplossPercent?: number; targetPercent?: number } | undefined;
        if (msg.action === "set_auto_exit_settings" && payloadMsg) {
          if (typeof payloadMsg.autoExit === "boolean") autoExitSettings.autoExit = payloadMsg.autoExit;
          if (typeof payloadMsg.stoplossPercent === "number" && payloadMsg.stoplossPercent >= 0) autoExitSettings.stoplossPercent = payloadMsg.stoplossPercent;
          if (typeof payloadMsg.targetPercent === "number" && payloadMsg.targetPercent >= 0) autoExitSettings.targetPercent = payloadMsg.targetPercent;
          return;
        }
        if (msg.action === "EXECUTE_MANUAL_TRADE") {
          if (isTradeExecuting) {
            sendTradeUpdate(ws, "Trade in progress, please wait", true);
            return;
          }
          const payload = msg.payload as {
            symbol: string;
            side: string;
            binanceApiKey: string;
            binanceApiSecret: string;
            bybitApiKey: string;
            bybitApiSecret: string;
            isExit?: boolean;
            quantity?: number;
            leverage?: number;
          } | undefined;
          if (
            !payload?.symbol ||
            !payload.side ||
            (payload.side !== "Long" && payload.side !== "Short") ||
            !payload.binanceApiKey ||
            !payload.binanceApiSecret ||
            !payload.bybitApiKey ||
            !payload.bybitApiSecret
          ) {
            sendTradeUpdate(ws, "Trade failed: Invalid symbol, side, or missing API credentials", true);
            return;
          }
          if (payload.isExit === true && (typeof payload.quantity !== "number" || payload.quantity <= 0)) {
            sendTradeUpdate(ws, "Trade failed: Exit requires quantity", true);
            return;
          }
          if (!payload) return;
          runManualTrade(ws, payload).catch((e) => {
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
