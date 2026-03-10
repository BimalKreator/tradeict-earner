import { NextResponse } from "next/server";
import {
  PrivateWSManager,
  executeCloseTrade,
  type ExchangeCredentials,
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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      symbol?: string;
      side?: string;
      quantity?: number;
      binanceApiKey?: string;
      binanceApiSecret?: string;
      bybitApiKey?: string;
      bybitApiSecret?: string;
    };
    const {
      symbol,
      side,
      quantity,
      binanceApiKey,
      binanceApiSecret,
      bybitApiKey,
      bybitApiSecret,
    } = body;

    if (!symbol?.trim() || !side || (side !== "Long" && side !== "Short")) {
      return NextResponse.json({ ok: false, error: "Invalid symbol or side" }, { status: 400 });
    }
    const qty = typeof quantity === "number" && quantity > 0 ? quantity : undefined;
    if (qty == null || qty <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid quantity" }, { status: 400 });
    }
    if (!binanceApiKey || !binanceApiSecret || !bybitApiKey || !bybitApiSecret) {
      return NextResponse.json({ ok: false, error: "Missing API credentials" }, { status: 400 });
    }

    const credentials: ExchangeCredentials = {
      binance: { apiKey: binanceApiKey, apiSecret: binanceApiSecret },
      bybit: { apiKey: bybitApiKey, apiSecret: bybitApiSecret },
    };

    const orderbook = await fetchOrderbookSnapshot(symbol);
    const privateWs = new PrivateWSManager(credentials);
    await privateWs.start();

    try {
      const result = await executeCloseTrade(
        symbol,
        side as OrderSide,
        qty,
        orderbook,
        credentials,
        privateWs
      );
      return NextResponse.json({
        ok: result.success,
        result,
        error: result.success ? undefined : result.error,
      });
    } finally {
      privateWs.stop();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Close failed";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
