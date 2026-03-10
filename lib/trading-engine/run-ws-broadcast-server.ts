/**
 * Standalone WebSocket server (port 8080) that runs the trading engine
 * and broadcasts aggregated symbol state to all connected Next.js frontend clients.
 *
 * Run: npx tsx lib/trading-engine/run-ws-broadcast-server.ts
 * Or:  npm run ws-server
 */

import { WebSocketServer } from "ws";
import { WsManager } from "./ws-manager";

const PORT = 8080;

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
        const msg = JSON.parse(data.toString()) as { action?: string; amount?: unknown };
        if (msg.action === "set_trade_amount") {
          const amount = Number(msg.amount);
          if (Number.isFinite(amount) && amount > 0) {
            manager.setVwapTargetAmount(amount);
          }
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
