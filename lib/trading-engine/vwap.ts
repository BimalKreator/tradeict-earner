import type { Orderbook, NumericLevel, VWAPResult } from "./types";

/**
 * Convert orderbook levels to numeric arrays (asks = sell side, use for buy VWAP).
 * Sorts asks ascending (best ask first), bids descending (best bid first).
 */
function toNumericLevels(levels: [string, string][]): NumericLevel[] {
  return levels.map(([p, q]) => [parseFloat(p), parseFloat(q)] as NumericLevel);
}

/**
 * Calculate VWAP for a given target amount using the provided side of the book.
 * - For buy VWAP: use asks (ascending by price).
 * - For sell VWAP: use bids (descending by price).
 * Checks if 2x target amount liquidity is available; if not, uses available depth.
 */
export function calculateVWAP(
  orderbook: Orderbook,
  targetAmount: number,
  side: "buy" | "sell"
): VWAPResult {
  const levels: NumericLevel[] =
    side === "buy"
      ? toNumericLevels(orderbook.asks).sort((a, b) => a[0] - b[0])
      : toNumericLevels(orderbook.bids).sort((a, b) => b[0] - a[0]);

  let cumulativeValue = 0;
  let cumulativeQty = 0;
  const requiredLiquidity = targetAmount * 2;
  let usedLiquidity = 0;
  let has2xLiquidity = false;

  for (const [price, qty] of levels) {
    const take = Math.min(qty, targetAmount - cumulativeQty);
    if (take <= 0) break;

    cumulativeValue += price * take;
    cumulativeQty += take;
    usedLiquidity += qty;

    if (cumulativeQty >= targetAmount) {
      has2xLiquidity = usedLiquidity >= requiredLiquidity;
      break;
    }
  }

  const vwap = cumulativeQty > 0 ? cumulativeValue / cumulativeQty : 0;

  return {
    vwap,
    filledAmount: cumulativeQty,
    usedLiquidity,
    has2xLiquidity,
  };
}

/**
 * Calculate buy VWAP (from asks) and sell VWAP (from bids) for a target amount.
 * Returns the buy VWAP as primary (used for state binanceVWAP/bybitVWAP in the manager).
 */
export function calculateVWAPBothSides(
  orderbook: Orderbook,
  targetAmount: number
): { buy: VWAPResult; sell: VWAPResult } {
  return {
    buy: calculateVWAP(orderbook, targetAmount, "buy"),
    sell: calculateVWAP(orderbook, targetAmount, "sell"),
  };
}
