import { NextResponse } from "next/server";
import {
  getBinancePositions,
  getBybitPositions,
  type RawPosition,
  type OrderSide,
} from "@/lib/trading-engine/execution-engine";

export interface GroupPositionLeg {
  exchange: "binance" | "bybit";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  side: OrderSide;
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
}

function groupPositions(binance: RawPosition[], bybit: RawPosition[]): GroupedPosition[] {
  const bySymbol = new Map<
    string,
    { binance: RawPosition | null; bybit: RawPosition | null }
  >();
  for (const p of binance) {
    const cur = bySymbol.get(p.symbol) ?? { binance: null, bybit: null };
    cur.binance = p;
    bySymbol.set(p.symbol, cur);
  }
  for (const p of bybit) {
    const cur = bySymbol.get(p.symbol) ?? { binance: null, bybit: null };
    cur.bybit = p;
    bySymbol.set(p.symbol, cur);
  }

  const out: GroupedPosition[] = [];
  Array.from(bySymbol.entries()).forEach(([symbol, legs]) => {
    const b = legs.binance;
    const y = legs.bybit;
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

    const toLeg = (p: RawPosition): GroupPositionLeg => ({
      exchange: p.exchange,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      liquidationPrice: p.liquidationPrice,
      unrealizedPnl: p.unrealizedPnl,
      side: p.side,
    });

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
    });
  });
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

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

    const [binanceList, bybitList] = await Promise.all([
      getBinancePositions(binanceApiKey, binanceApiSecret),
      getBybitPositions(bybitApiKey, bybitApiSecret),
    ]);

    const positions = groupPositions(binanceList, bybitList);
    return NextResponse.json({ positions });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to fetch positions";
    return NextResponse.json({ error: message }, { status: 200 });
  }
}
