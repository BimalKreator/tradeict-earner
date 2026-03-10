import { NextResponse } from "next/server";
import { getBinanceBalance, getBybitBalance } from "@/lib/trading-engine/execution-engine";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      binanceApiKey?: string;
      binanceApiSecret?: string;
      bybitApiKey?: string;
      bybitApiSecret?: string;
    };
    const { binanceApiKey, binanceApiSecret, bybitApiKey, bybitApiSecret } = body;
    if (!binanceApiKey || !binanceApiSecret || !bybitApiKey || !bybitApiSecret) {
      return NextResponse.json(
        { error: "Missing API credentials" },
        { status: 400 }
      );
    }

    const [binance, bybit] = await Promise.all([
      getBinanceBalance(binanceApiKey, binanceApiSecret),
      getBybitBalance(bybitApiKey, bybitApiSecret),
    ]);

    return NextResponse.json({ binance, bybit });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to fetch balances";
    return NextResponse.json({ error: message }, { status: 200 });
  }
}
