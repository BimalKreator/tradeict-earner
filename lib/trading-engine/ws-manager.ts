import WebSocket from "ws";
import type { Orderbook, OrderbookLevel, SymbolState, VWAPResult } from "./types";
import { calculateVWAP as calcVWAP } from "./vwap";

/** Calculate VWAP for buy side; checks 3x liquidity. */
export function calculateVWAP(orderbook: Orderbook, targetAmount: number): VWAPResult {
  return calcVWAP(orderbook, targetAmount, "buy");
}
export type { VWAPResult } from "./types";

const BINANCE_FUTURES_WS = "wss://fstream.binance.com/stream";
const BYBIT_LINEAR_WS = "wss://stream.bybit.com/v5/public/linear";
const BINANCE_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BYBIT_INSTRUMENTS = "https://api.bybit.com/v5/market/instruments-info?category=linear";

/** Default trade amount (in quote/USDT) used for VWAP calculation */
const DEFAULT_VWAP_TARGET_AMOUNT = 10_000;

/** Base threshold (absolute L2 spread %) above which we track stability duration. */
const SPREAD_STABILITY_THRESHOLD_PCT = 0.2;

export type OnStateUpdate = (states: SymbolState[]) => void;

export interface WsManagerOptions {
  /** Trade amount (quote) used for VWAP; also checks 3x liquidity. */
  vwapTargetAmount?: number;
  /** Max number of common symbols to subscribe to (exchange limits). Default 50. */
  maxSymbols?: number;
  /** Called whenever any symbol state is updated. */
  onStateUpdate?: OnStateUpdate;
}

interface OrderbookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
}

function sortBidsDesc(a: OrderbookLevel, b: OrderbookLevel) {
  return parseFloat(b[0]) - parseFloat(a[0]);
}
function sortAsksAsc(a: OrderbookLevel, b: OrderbookLevel) {
  return parseFloat(a[0]) - parseFloat(b[0]);
}

function orderbookFromMaps(ob: OrderbookState): Orderbook {
  const bids: OrderbookLevel[] = Array.from(ob.bids.entries())
    .filter(([, q]) => q > 0)
    .map(([p, q]) => [String(p), String(q)])
    .sort(sortBidsDesc)
    .slice(0, 20);
  const asks: OrderbookLevel[] = Array.from(ob.asks.entries())
    .filter(([, q]) => q > 0)
    .map(([p, q]) => [String(p), String(q)])
    .sort(sortAsksAsc)
    .slice(0, 20);
  return { bids, asks };
}

function applyDepthDelta(ob: OrderbookState, levels: OrderbookLevel[], side: "bids" | "asks") {
  const map = side === "bids" ? ob.bids : ob.asks;
  for (const [p, q] of levels) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (qty === 0) map.delete(price);
    else map.set(price, qty);
  }
}

/**
 * Fetch common USDT-margined perpetual symbols between Binance Futures and Bybit Linear.
 */
export async function fetchCommonUsdtPerpetualSymbols(): Promise<string[]> {
  const [binanceRes, bybitRes] = await Promise.all([
    fetch(BINANCE_EXCHANGE_INFO),
    fetch(BYBIT_INSTRUMENTS),
  ]);

  if (!binanceRes.ok || !bybitRes.ok) {
    throw new Error("Failed to fetch exchange info");
  }

  const binanceData = (await binanceRes.json()) as {
    symbols?: { symbol: string; contractType?: string; quoteAsset?: string }[];
  };
  const bybitData = (await bybitRes.json()) as {
    result?: { list?: { symbol: string; contractType?: string }[] };
  };

  const binanceSet = new Set(
    (binanceData.symbols ?? [])
      .filter((s) => (s.contractType ?? "") === "PERPETUAL" && (s.quoteAsset ?? "") === "USDT")
      .map((s) => s.symbol)
  );

  const bybitSet = new Set(
    (bybitData.result?.list ?? [])
      .filter((s) => (s.contractType ?? "").includes("Perpetual") && (s.status ?? "") === "Trading")
      .map((s) => s.symbol)
      .filter((s) => s.endsWith("USDT"))
  );

  const common = [...binanceSet].filter((s) => bybitSet.has(s));
  return common.sort();
}

export class WsManager {
  private symbols: string[] = [];
  private vwapTargetAmount: number;
  private onStateUpdate?: OnStateUpdate;

  private binanceWs: WebSocket | null = null;
  private bybitWs: WebSocket | null = null;

  /** Orderbooks per symbol per exchange (price -> qty map for merge). */
  private binanceOrderbooks = new Map<string, OrderbookState>();
  private bybitOrderbooks = new Map<string, OrderbookState>();

  /** Funding rates (decimal, e.g. 0.0001 = 0.01%). */
  private binanceFunding = new Map<string, number>();
  private bybitFunding = new Map<string, number>();

  /** Latest state per symbol, for broadcast. */
  private state = new Map<string, SymbolState>();

  /** Per-symbol: timestamp (ms) when spread first went above threshold, or null. */
  private spreadAboveThresholdSince = new Map<string, number | null>();

  constructor(options: WsManagerOptions = {}) {
    this.vwapTargetAmount = options.vwapTargetAmount ?? DEFAULT_VWAP_TARGET_AMOUNT;
    this.onStateUpdate = options.onStateUpdate;
    this.maxSymbols = options.maxSymbols ?? 50;
  }

  private maxSymbols: number;

  /**
   * Initialize: fetch common symbols, connect to Binance and Bybit, subscribe to
   * depth (top 20) and funding for each common symbol.
   */
  async start(): Promise<string[]> {
    const all = await fetchCommonUsdtPerpetualSymbols();
    if (all.length === 0) {
      throw new Error("No common USDT perpetual symbols found");
    }
    this.symbols = all.slice(0, this.maxSymbols);

    for (const symbol of this.symbols) {
      this.binanceOrderbooks.set(symbol, { bids: new Map(), asks: new Map() });
      this.bybitOrderbooks.set(symbol, { bids: new Map(), asks: new Map() });
      this.ensureState(symbol);
    }

    this.connectBinance();
    this.connectBybit();
    return this.symbols;
  }

  private ensureState(symbol: string): void {
    if (!this.state.has(symbol)) {
      this.state.set(symbol, {
        symbol,
        binanceVWAP: null,
        bybitVWAP: null,
        binanceFunding: null,
        bybitFunding: null,
        lastUpdate: 0,
        spreadStableMs: 0,
        has3xLiquidity: false,
      });
    }
  }

  private connectBinance(): void {
    const streams: string[] = [];
    for (const symbol of this.symbols) {
      const lower = symbol.toLowerCase();
      streams.push(`${lower}@depth20@100ms`);
      streams.push(`${lower}@markPrice`);
    }
    const url = `${BINANCE_FUTURES_WS}?streams=${streams.join("/")}`;
    this.binanceWs = new WebSocket(url);

    this.binanceWs.on("open", () => {
      console.log("[WsManager] Binance Futures WebSocket connected");
    });

    this.binanceWs.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { stream?: string; data?: unknown };
        const stream = msg.stream ?? "";
        const d = msg.data as Record<string, unknown> | undefined;
        if (!d) return;

        const symbol = String(d.s ?? "").toUpperCase();
        if (!symbol || !this.symbols.includes(symbol)) return;

        if (stream.endsWith("@depth20@100ms")) {
          const b = (d.b as [string, string][] | undefined) ?? [];
          const a = (d.a as [string, string][] | undefined) ?? [];
          const ob = this.binanceOrderbooks.get(symbol)!;
          applyDepthDelta(ob, b, "bids");
          applyDepthDelta(ob, a, "asks");
          this.recomputeAndEmit(symbol, "binance");
        } else if (stream.endsWith("@markPrice")) {
          const r = d.r as string | undefined;
          if (r != null) this.binanceFunding.set(symbol, parseFloat(r));
          this.recomputeAndEmit(symbol, "binance");
        }
      } catch (e) {
        console.error("[WsManager] Binance message error:", e);
      }
    });

    this.binanceWs.on("error", (err) => console.error("[WsManager] Binance WS error:", err));
    this.binanceWs.on("close", () => {
      console.log("[WsManager] Binance WebSocket closed");
    });
  }

  private connectBybit(): void {
    this.bybitWs = new WebSocket(BYBIT_LINEAR_WS);

    this.bybitWs.on("open", () => {
      console.log("[WsManager] Bybit Linear WebSocket connected");
      const args: string[] = [];
      for (const symbol of this.symbols) {
        args.push(`orderbook.50.${symbol}`);
        args.push(`tickers.${symbol}`);
      }
      this.bybitWs!.send(JSON.stringify({ op: "subscribe", args }));
    });

    this.bybitWs.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          topic?: string;
          type?: string;
          data?: Record<string, unknown>;
        };
        const topic = msg.topic ?? "";
        const type = msg.type ?? "";
        const d = msg.data;

        if (topic.startsWith("orderbook.")) {
          const symbol = topic.split(".").pop() as string;
          if (!this.symbols.includes(symbol) || !d) return;

          const ob = this.bybitOrderbooks.get(symbol)!;
          const b = (d.b as [string, string][] | undefined) ?? [];
          const a = (d.a as [string, string][] | undefined) ?? [];

          if (type === "snapshot") {
            ob.bids.clear();
            ob.asks.clear();
          }
          applyDepthDelta(ob, b, "bids");
          applyDepthDelta(ob, a, "asks");
          this.recomputeAndEmit(symbol, "bybit");
        } else if (topic.startsWith("tickers.")) {
          const symbol = topic.replace("tickers.", "");
          if (!this.symbols.includes(symbol) || !d) return;
          const fr = d.fundingRate as string | undefined;
          if (fr != null) this.bybitFunding.set(symbol, parseFloat(fr));
          this.recomputeAndEmit(symbol, "bybit");
        }
      } catch (e) {
        console.error("[WsManager] Bybit message error:", e);
      }
    });

    this.bybitWs.on("error", (err) => console.error("[WsManager] Bybit WS error:", err));
    this.bybitWs.on("close", () => {
      console.log("[WsManager] Bybit WebSocket closed");
    });
  }

  private recomputeAndEmit(symbol: string, _exchange: "binance" | "bybit"): void {
    const s = this.state.get(symbol)!;
    const binanceOb = this.binanceOrderbooks.get(symbol)!;
    const bybitOb = this.bybitOrderbooks.get(symbol)!;

    const binanceBook = orderbookFromMaps(binanceOb);
    const bybitBook = orderbookFromMaps(bybitOb);

    const target = this.vwapTargetAmount;
    const now = Date.now();

    let binanceVWAP: number | null = null;
    let binanceHas3x = false;
    if (binanceBook.asks.length > 0) {
      const buy = calcVWAP(binanceBook, target, "buy");
      binanceVWAP = buy.vwap;
      binanceHas3x = buy.has3xLiquidity;
    }

    let bybitVWAP: number | null = null;
    let bybitHas3x = false;
    if (bybitBook.asks.length > 0) {
      const buy = calcVWAP(bybitBook, target, "buy");
      bybitVWAP = buy.vwap;
      bybitHas3x = buy.has3xLiquidity;
    }

    s.binanceVWAP = binanceVWAP;
    s.bybitVWAP = bybitVWAP;
    s.binanceFunding = this.binanceFunding.get(symbol) ?? s.binanceFunding;
    s.bybitFunding = this.bybitFunding.get(symbol) ?? s.bybitFunding;
    s.has3xLiquidity = binanceHas3x && bybitHas3x;
    s.lastUpdate = now;

    const absL2SpreadPct =
      binanceVWAP != null && bybitVWAP != null && binanceVWAP !== 0
        ? Math.abs((bybitVWAP - binanceVWAP) / binanceVWAP * 100)
        : 0;

    if (absL2SpreadPct >= SPREAD_STABILITY_THRESHOLD_PCT) {
      const since = this.spreadAboveThresholdSince.get(symbol) ?? null;
      const start = since ?? now;
      if (since == null) this.spreadAboveThresholdSince.set(symbol, now);
      s.spreadStableMs = now - start;
    } else {
      this.spreadAboveThresholdSince.set(symbol, null);
      s.spreadStableMs = 0;
    }

    this.onStateUpdate?.(this.getStates());
  }

  /**
   * Calculate VWAP for a given orderbook and target amount.
   * Returns has3xLiquidity if total liquidity >= 3 * targetAmount.
   */
  calculateVWAP(orderbook: Orderbook, targetAmount: number): VWAPResult {
    return calcVWAP(orderbook, targetAmount, "buy");
  }

  getStates(): SymbolState[] {
    return this.symbols.map((sym) => this.state.get(sym)!);
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  getVwapTargetAmount(): number {
    return this.vwapTargetAmount;
  }

  /** Update VWAP target amount and recompute all symbol states. */
  setVwapTargetAmount(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.vwapTargetAmount = amount;
    this.recomputeAll();
  }

  /** Recalculate VWAP, funding-derived values, and stability for all symbols. */
  recomputeAll(): void {
    for (const symbol of this.symbols) {
      this.recomputeAndEmit(symbol, "binance");
    }
  }

  stop(): void {
    this.binanceWs?.close();
    this.bybitWs?.close();
    this.binanceWs = null;
    this.bybitWs = null;
  }
}
