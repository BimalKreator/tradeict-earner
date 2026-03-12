import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import {
  getBinancePositions,
  getBybitPositions,
  type RawPosition,
  type OrderSide,
} from "@/lib/trading-engine/execution-engine";
import { authOptions } from "@/lib/auth";
import { findUserByEmail } from "@/lib/auth-users";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export interface GroupPositionLeg {
  exchange: "binance" | "bybit";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  side: OrderSide;
  marginUsed: number;
}

export interface GroupedPosition {
  symbol: string;
  side: OrderSide;
  binance: GroupPositionLeg | null;
  bybit: GroupPositionLeg | null;
  totalQuantity: number;
  entryPrice: number;
  liquidationPrice: number;
  groupPnl: number;
  markPriceBinance: number | null;
  markPriceBybit: number | null;
  /** Sum of margin used across both legs (USD). */
  usedMargin: number;
}

function normalizeSymbol(s: string): string {
  return (s || "").toUpperCase();
}

function toLeg(p: RawPosition): GroupPositionLeg {
  return {
    exchange: p.exchange,
    quantity: p.quantity,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    liquidationPrice: p.liquidationPrice,
    unrealizedPnl: p.unrealizedPnl,
    side: p.side,
    marginUsed: p.marginUsed ?? 0,
  };
}

/** Group by normalized symbol. Include orphans (position on one exchange only). */
function groupPositions(binance: RawPosition[], bybit: RawPosition[]): GroupedPosition[] {
  const bySymbol = new Map<
    string,
    { binance: RawPosition | null; bybit: RawPosition | null }
  >();
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
  Array.from(bySymbol.entries()).forEach(([symbol, legs]) => {
    const b = legs.binance;
    const y = legs.bybit;
    if (!b && !y) return;
    const totalQuantity = b && y ? Math.min(b.quantity, y.quantity) : (b?.quantity ?? 0) + (y?.quantity ?? 0);
    if (totalQuantity <= 0) return;

    const side: OrderSide = b?.side ?? y?.side ?? "Long";
    let entryPrice = 0;
    let liqPrice = 0;
    let groupPnl = 0;
    if (b && y) {
      const notionalB = b.quantity * b.entryPrice;
      const notionalY = y.quantity * y.entryPrice;
      entryPrice = (notionalB + notionalY) / (b.quantity + y.quantity);
      liqPrice = Math.max(b.liquidationPrice, y.liquidationPrice) || Math.min(b.liquidationPrice, y.liquidationPrice) || 0;
      groupPnl = b.unrealizedPnl + y.unrealizedPnl;
    } else if (b) {
      entryPrice = b.entryPrice;
      liqPrice = b.liquidationPrice;
      groupPnl = b.unrealizedPnl;
    } else if (y) {
      entryPrice = y.entryPrice;
      liqPrice = y.liquidationPrice;
      groupPnl = y.unrealizedPnl;
    }

    const usedMargin = (b?.marginUsed ?? 0) + (y?.marginUsed ?? 0);
    out.push({
      symbol,
      side,
      binance: b ? toLeg(b) : null,
      bybit: y ? toLeg(y) : null,
      totalQuantity,
      entryPrice,
      liquidationPrice: liqPrice,
      groupPnl,
      markPriceBinance: b?.markPrice ?? null,
      markPriceBybit: y?.markPrice ?? null,
      usedMargin,
    });
  });
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

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

    const [binanceList, bybitList] = await Promise.all([
      getBinancePositions(binanceApiKey, binanceApiSecret),
      getBybitPositions(bybitApiKey, bybitApiSecret),
    ]);

    const activeBinance = binanceList.filter((p) => p.quantity > 0);
    const activeBybit = bybitList.filter((p) => p.quantity > 0);
    const positions = groupPositions(activeBinance, activeBybit);
    return NextResponse.json({ positions });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to fetch positions";
    return NextResponse.json({ error: message }, { status: 200 });
  }
}
