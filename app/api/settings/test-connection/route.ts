import { NextResponse } from "next/server";
import { getBinanceBalance, getBybitBalance } from "@/lib/trading-engine/execution-engine";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      exchange?: string;
      apiKey?: string;
      apiSecret?: string;
    };
    const { exchange, apiKey, apiSecret } = body;
    if (!exchange || !apiKey || !apiSecret) {
      return NextResponse.json(
        { ok: false, error: "Missing exchange, apiKey, or apiSecret" },
        { status: 400 }
      );
    }
    if (exchange !== "binance" && exchange !== "bybit") {
      return NextResponse.json(
        { ok: false, error: "Invalid exchange" },
        { status: 400 }
      );
    }

    if (exchange === "binance") {
      await getBinanceBalance(apiKey, apiSecret);
      return NextResponse.json({ ok: true });
    }
    await getBybitBalance(apiKey, apiSecret);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Connection failed";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
