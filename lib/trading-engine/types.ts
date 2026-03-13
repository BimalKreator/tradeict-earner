/** Orderbook level: [price, quantity] */
export type OrderbookLevel = [string, string];

export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

/** Parsed numeric level for VWAP: [price, quantity] */
export type NumericLevel = [number, number];

export interface SymbolState {
  symbol: string;
  binanceVWAP: number | null;
  bybitVWAP: number | null;
  binanceFunding: number | null;
  bybitFunding: number | null;
  /** Funding interval (ms). Derived from nextFundingTime jumps via WS; default 8h until detected. */
  binanceFundingInterval?: number | null;
  bybitFundingInterval?: number | null;
  lastUpdate: number;
  /** How long (ms) absolute L2 spread % has stayed above the stability threshold. */
  spreadStableMs: number;
  /** True if both exchanges have orderbook liquidity >= 3 * targetAmount. */
  has3xLiquidity: boolean;
}

export interface VWAPResult {
  vwap: number;
  filledAmount: number;
  usedLiquidity: number;
  /** True if total orderbook liquidity on the side >= 3 * targetAmount. */
  has3xLiquidity: boolean;
}
