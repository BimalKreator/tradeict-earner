import { NextResponse } from "next/server";
import {
  PrivateWSManager,
  executeChunkTrade,
  getBinanceBalance,
  getBybitBalance,
  type ExchangeCredentials,
  type ExecutionSettings,
  type OrderbookSnapshot,
  type OrderSide,
} from "@/lib/trading-engine/execution-engine";

const BINANCE_DEPTH = "https://fapi.binance.com/fapi/v1/depth";

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

const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  capitalPercent: 10,
  minChunkNotional: 6,
  bybitToBinanceDelayMs: 10,
  chunkLiquidityFraction: 0.5,
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      symbol?: string;
      side?: string;
      binanceApiKey?: string;
      binanceApiSecret?: string;
      bybitApiKey?: string;
      bybitApiSecret?: string;
    };
    const {
      symbol,
      side,
      binanceApiKey,
      binanceApiSecret,
      bybitApiKey,
      bybitApiSecret,
    } = body;

    if (!symbol?.trim() || !side || side !== "Long" && side !== "Short") {
      return NextResponse.json({ ok: false, error: "Invalid symbol or side" }, { status: 400 });
    }
    if (!binanceApiKey || !binanceApiSecret || !bybitApiKey || !bybitApiSecret) {
      return NextResponse.json({ ok: false, error: "Missing API credentials" }, { status: 400 });
    }

    const credentials: ExchangeCredentials = {
      binance: { apiKey: binanceApiKey, apiSecret: binanceApiSecret },
      bybit: { apiKey: bybitApiKey, apiSecret: bybitApiSecret },
    };

    const [orderbook, binanceData, bybitData] = await Promise.all([
      fetchOrderbookSnapshot(symbol),
      getBinanceBalance(binanceApiKey, binanceApiSecret),
      getBybitBalance(bybitApiKey, bybitApiSecret),
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
        bybitL2
      );
      const success = results.length > 0 && results.some((r) => r.success);
      return NextResponse.json({
        ok: success,
        results,
        error: success ? undefined : (results[0]?.error ?? "Execution failed"),
      });
    } finally {
      privateWs.stop();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Execution failed";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
