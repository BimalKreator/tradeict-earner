import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getBinanceBalance, getBybitBalance } from "@/lib/trading-engine/execution-engine";
import { authOptions } from "@/lib/auth";
import { findUserByEmail } from "@/lib/auth-users";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = findUserByEmail(session.user.email);
    if (!user?.apiKeys?.binanceApiKey || !user?.apiKeys?.binanceApiSecret || !user?.apiKeys?.bybitApiKey || !user?.apiKeys?.bybitApiSecret) {
      return NextResponse.json(
        { error: "API keys not configured. Save them in Settings." },
        { status: 400 }
      );
    }
    const { binanceApiKey, binanceApiSecret, bybitApiKey, bybitApiSecret } = user.apiKeys;

    const [binance, bybit] = await Promise.all([
      getBinanceBalance(binanceApiKey, binanceApiSecret),
      getBybitBalance(bybitApiKey, bybitApiSecret),
    ]);

    return NextResponse.json({
      binance: { total: binance.total, used: binance.used, available: binance.available },
      bybit: { total: bybit.total, used: bybit.used, available: bybit.available },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to fetch balances";
    return NextResponse.json({ error: message }, { status: 200 });
  }
}
