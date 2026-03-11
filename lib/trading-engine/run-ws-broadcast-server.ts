/**
 * Standalone WebSocket server (port 8080) that runs the trading engine
 * and broadcasts aggregated symbol state to all connected Next.js frontend clients.
 * Manual trades are executed here (EXECUTE_MANUAL_TRADE) and progress is sent via TRADE_UPDATE.
 *
 * Run: npx tsx lib/trading-engine/run-ws-broadcast-server.ts
 * Or:  npm run ws-server
 */

import { WebSocketServer } from "ws";
import { WsManager } from "./ws-manager";
import {
  PrivateWSManager,
  executeChunkTrade,
  getBinanceBalance,
  getBybitBalance,
  type ExchangeCredentials,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
} from "./execution-engine";

const PORT = 8080;
const BINANCE_DEPTH = "https://fapi.binance.com/fapi/v1/depth";

const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  capitalPercent: 10,
  minChunkNotional: 6,
  bybitToBinanceDelayMs: 10,
  chunkLiquidityFraction: 0.5,
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
    binanceApiKey: string;
    binanceApiSecret: string;
    bybitApiKey: string;
    bybitApiSecret: string;
  }
) {
  const { symbol, side } = payload;
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

  console.log("[CHUNK-SYSTEM] Manual trade requested via WS: symbol=" + symbol + " side=" + side);

  const [orderbook, binanceData, bybitData] = await Promise.all([
    fetchOrderbookSnapshot(symbol),
    getBinanceBalance(payload.binanceApiKey, payload.binanceApiSecret),
    getBybitBalance(payload.bybitApiKey, payload.bybitApiSecret),
  ]);
  const binanceBalance = binanceData.available;
  const bybitBalance = bybitData.available;

  const bestAsk = orderbook.asks[0]?.[0] ? parseFloat(orderbook.asks[0][0]) : 0;
  const bestBid = orderbook.bids[0]?.[0] ? parseFloat(orderbook.bids[0][0]) : 0;
  const binanceL2 = side === "Long" ? bestAsk : bestBid;
  const bybitL2 = binanceL2;

  const privateWs = new PrivateWSManager(credentials);
  await privateWs.start();

  try {
    const results = await executeChunkTrade(
      symbol,
      side as OrderSide,
      orderbook,
      DEFAULT_EXECUTION_SETTINGS,
      credentials,
      privateWs,
      binanceBalance,
      bybitBalance,
      binanceL2,
      bybitL2,
      (message) => sendTradeUpdate(ws, message)
    );
    const success = results.length > 0 && results.some((r) => r.success);
    if (success) {
      sendTradeUpdate(ws, "Trade completed", true);
    } else {
      const err = results[0]?.error ?? "Execution failed";
      sendTradeUpdate(ws, `Trade failed: ${err}`, true);
    }
  } finally {
    privateWs.stop();
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
        if (msg.action === "EXECUTE_MANUAL_TRADE") {
          const payload = msg.payload;
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
          runManualTrade(ws, payload as { symbol: string; side: string; binanceApiKey: string; binanceApiSecret: string; bybitApiKey: string; bybitApiSecret: string }).catch((e) => {
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
