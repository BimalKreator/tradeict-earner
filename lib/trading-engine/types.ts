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
  lastUpdate: number;
}

export interface VWAPResult {
  vwap: number;
  filledAmount: number;
  usedLiquidity: number;
  has2xLiquidity: boolean;
}
