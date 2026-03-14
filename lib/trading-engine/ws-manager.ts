import WebSocket from "ws";
import type { Orderbook, OrderbookLevel, SymbolState, VWAPResult } from "./types";
import type { OrderbookSnapshot } from "./execution-engine";
import { calculateVWAP as calcVWAP } from "./vwap";
import { reportBinanceBan, reportBybitBan, parseBanUntilFromError } from "./system-state";

/** Calculate VWAP for buy side; checks 3x liquidity. */
export function calculateVWAP(orderbook: Orderbook, targetAmount: number): VWAPResult {
  return calcVWAP(orderbook, targetAmount, "buy");
}
export type { VWAPResult } from "./types";

const BINANCE_FUTURES_WS = "wss://fstream.binance.com/stream";
const BYBIT_LINEAR_WS = "wss://stream.bybit.com/v5/public/linear";
const BINANCE_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BYBIT_INSTRUMENTS = "https://api.bybit.com/v5/market/instruments-info?category=linear";
const MAX_ORDERBOOK_LEVELS = 20;

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const WS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

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
    .map(([p, q]) => [String(p), String(q)] as OrderbookLevel)
    .sort(sortBidsDesc)
    .slice(0, MAX_ORDERBOOK_LEVELS);
  const asks: OrderbookLevel[] = Array.from(ob.asks.entries())
    .filter(([, q]) => q > 0)
    .map(([p, q]) => [String(p), String(q)] as OrderbookLevel)
    .sort(sortAsksAsc)
    .slice(0, MAX_ORDERBOOK_LEVELS);
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
  trimOrderbookState(ob, MAX_ORDERBOOK_LEVELS);
}

/** Keep only top N levels per side to prevent unbounded memory growth. */
function trimOrderbookState(ob: OrderbookState, maxLevels: number) {
  if (ob.bids.size > maxLevels) {
    const sortedBids = Array.from(ob.bids.entries()).sort((a, b) => b[0] - a[0]);
    ob.bids.clear();
    for (let i = 0; i < maxLevels; i++) {
      if (sortedBids[i]) ob.bids.set(sortedBids[i][0], sortedBids[i][1]);
    }
  }
  if (ob.asks.size > maxLevels) {
    const sortedAsks = Array.from(ob.asks.entries()).sort((a, b) => a[0] - b[0]);
    ob.asks.clear();
    for (let i = 0; i < maxLevels; i++) {
      if (sortedAsks[i]) ob.asks.set(sortedAsks[i][0], sortedAsks[i][1]);
    }
  }
}

/**
 * Fetch common USDT-margined perpetual symbols between Binance Futures and Bybit Linear.
 * Uses realistic headers and retries once on failure.
 */
export async function fetchCommonUsdtPerpetualSymbols(): Promise<string[]> {
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const [binanceRes, bybitRes] = await Promise.all([
        fetch(BINANCE_EXCHANGE_INFO, { headers: FETCH_HEADERS }),
        fetch(BYBIT_INSTRUMENTS, { headers: FETCH_HEADERS }),
      ]);

      if (!binanceRes.ok || !bybitRes.ok) {
        throw new Error(
          `HTTP ${binanceRes.status}/${bybitRes.status} (attempt ${attempt}/${maxRetries})`
        );
      }

      const binanceData = (await binanceRes.json()) as {
        symbols?: { symbol: string; contractType?: string; quoteAsset?: string }[];
      };
      const bybitData = (await bybitRes.json()) as {
        result?: { list?: { symbol: string; contractType?: string; status?: string }[] };
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

      const common = Array.from(binanceSet).filter((s) => bybitSet.has(s));
      return common.sort();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch exchange info inside fetchCommonUsdtPerpetualSymbols. ${msg}`);
      }
      console.warn(`[WsManager] Exchange info fetch attempt ${attempt} failed: ${msg}. Retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw new Error("Failed to fetch exchange info inside fetchCommonUsdtPerpetualSymbols.");
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

  /** Next funding time (ms) per symbol; used to detect interval jumps. */
  private binanceNextFunding = new Map<string, number>();
  private bybitNextFunding = new Map<string, number>();
  /** Computed funding interval (ms) per symbol when nextFundingTime jumps. */
  private binanceIntervals = new Map<string, number>();
  private bybitIntervals = new Map<string, number>();

  /** Latest state per symbol, for broadcast. */
  private state = new Map<string, SymbolState>();

  /** Per-symbol: timestamp (ms) when spread first went above threshold, or null. */
  private spreadAboveThresholdSince = new Map<string, number | null>();

  /** Set to true in stop() so close handlers do not reconnect. */
  private stopped = false;

  /** REST poller for funding intervals (3 chunks, one every 10 min). */
  private fundingPollerInterval: ReturnType<typeof setInterval> | null = null;
  private currentFundingChunkIndex = 0;

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
    this.stopped = false;
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
    await this.startFundingIntervalPoller();
    return this.symbols;
  }

  /** Fetch funding interval for one symbol via REST (current - previous funding time). */
  private async fetchFundingIntervalRest(symbol: string): Promise<void> {
    try {
      const headers = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

      const binRes = await fetch(
        `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=2`,
        { headers }
      );
      if (binRes.ok) {
        const binData = (await binRes.json()) as { fundingTime: number }[];
        if (Array.isArray(binData) && binData.length >= 2) {
          const t1 = Number(binData[0].fundingTime);
          const t2 = Number(binData[1].fundingTime);
          if (t1 && t2) this.binanceIntervals.set(symbol, Math.abs(t1 - t2));
        }
      } else if (binRes.status === 418 || binRes.status === 429) {
        const text = await binRes.text();
        reportBinanceBan(parseBanUntilFromError(binRes.status, text));
      }

      const bybRes = await fetch(
        `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=2`,
        { headers }
      );
      if (bybRes.ok) {
        const bybData = (await bybRes.json()) as { result?: { list?: { fundingRateTimestamp: string | number }[] } };
        const list = bybData?.result?.list;
        if (Array.isArray(list) && list.length >= 2) {
          const t1 = Number(list[0].fundingRateTimestamp);
          const t2 = Number(list[1].fundingRateTimestamp);
          if (t1 && t2) this.bybitIntervals.set(symbol, Math.abs(t1 - t2));
        }
      } else if (bybRes.status === 418 || bybRes.status === 429) {
        const text = await bybRes.text();
        reportBybitBan(parseBanUntilFromError(bybRes.status, text));
      }
    } catch (err) {
      console.error(`[WsManager] Failed to fetch REST funding interval for ${symbol}`, err);
    }
  }

  /** Run one chunk of REST funding interval fetches; then schedule next chunk in 10 min. */
  private async startFundingIntervalPoller(): Promise<void> {
    const chunkSize = Math.ceil(this.symbols.length / 3);
    const chunks = [
      this.symbols.slice(0, chunkSize),
      this.symbols.slice(chunkSize, chunkSize * 2),
      this.symbols.slice(chunkSize * 2),
    ].filter((c) => c.length > 0);

    const processChunk = async (): Promise<void> => {
      if (chunks.length === 0) return;
      const chunk = chunks[this.currentFundingChunkIndex];
      for (const symbol of chunk) {
        await this.fetchFundingIntervalRest(symbol);
        await new Promise((r) => setTimeout(r, 500));
      }
      this.recomputeAll();
      this.currentFundingChunkIndex = (this.currentFundingChunkIndex + 1) % chunks.length;
    };

    await processChunk();
    this.fundingPollerInterval = setInterval(processChunk, 10 * 60 * 1000);
  }

  private ensureState(symbol: string): void {
    if (!this.state.has(symbol)) {
      this.state.set(symbol, {
        symbol,
        binanceVWAP: null,
        bybitVWAP: null,
        binanceFunding: null,
        bybitFunding: null,
        binanceFundingInterval: 28800000,
        bybitFundingInterval: 28800000,
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
    this.binanceWs = new WebSocket(url, {
      headers: { ...WS_HEADERS, Origin: "https://fstream.binance.com" },
    });

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
          const T = d.T as number | undefined;
          if (T != null && typeof T === "number") {
            const oldT = this.binanceNextFunding.get(symbol);
            if (oldT != null && T > oldT) {
              this.binanceIntervals.set(symbol, T - oldT);
            }
            this.binanceNextFunding.set(symbol, T);
          }
          this.recomputeAndEmit(symbol, "binance");
        }
      } catch (e) {
        console.error("[WsManager] Binance message error:", e);
      }
    });

    this.binanceWs.on("error", (err) => console.error("[WsManager] Binance WS error:", err));
    this.binanceWs.on("close", () => {
      this.binanceWs = null;
      console.log("[WsManager] Binance WebSocket closed");
      if (!this.stopped) {
        console.log("[WsManager] Reconnecting Binance in 5s...");
        setTimeout(() => this.connectBinance(), 5000);
      }
    });
  }

  private connectBybit(): void {
    this.bybitWs = new WebSocket(BYBIT_LINEAR_WS, {
      headers: { ...WS_HEADERS, Origin: "https://www.bybit.com" },
    });

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
          const T = Number(d.nextFundingTime);
          if (T && !isNaN(T)) {
            const oldT = this.bybitNextFunding.get(symbol);
            if (oldT != null && T > oldT) {
              this.bybitIntervals.set(symbol, T - oldT);
            }
            this.bybitNextFunding.set(symbol, T);
          }
          this.recomputeAndEmit(symbol, "bybit");
        }
      } catch (e) {
        console.error("[WsManager] Bybit message error:", e);
      }
    });

    this.bybitWs.on("error", (err) => console.error("[WsManager] Bybit WS error:", err));
    this.bybitWs.on("close", () => {
      this.bybitWs = null;
      console.log("[WsManager] Bybit WebSocket closed");
      if (!this.stopped) {
        console.log("[WsManager] Reconnecting Bybit in 5s...");
        setTimeout(() => this.connectBybit(), 5000);
      }
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
    s.binanceFundingInterval = this.binanceIntervals.get(symbol) ?? 28800000;
    s.bybitFundingInterval = this.bybitIntervals.get(symbol) ?? 28800000;
    s.binanceNextFundingTime = this.binanceNextFunding.get(symbol);
    s.bybitNextFundingTime = this.bybitNextFunding.get(symbol);
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

  /** Returns instant in-memory Binance orderbook for Auto-Exit L2 VWAP. */
  getLiveOrderbook(symbol: string): OrderbookSnapshot | null {
    const key = (symbol || "").toUpperCase();
    const ob = this.binanceOrderbooks.get(key);
    if (!ob || (ob.bids.size === 0 && ob.asks.size === 0)) return null;
    const book = orderbookFromMaps(ob);
    return { symbol: key, bids: book.bids, asks: book.asks };
  }

  /** Returns instant in-memory Bybit orderbook for per-position exit VWAP. */
  getBybitLiveOrderbook(symbol: string): OrderbookSnapshot | null {
    const key = (symbol || "").toUpperCase();
    const ob = this.bybitOrderbooks.get(key);
    if (!ob || (ob.bids.size === 0 && ob.asks.size === 0)) return null;
    const book = orderbookFromMaps(ob);
    return { symbol: key, bids: book.bids, asks: book.asks };
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
    this.stopped = true;
    if (this.fundingPollerInterval) {
      clearInterval(this.fundingPollerInterval);
      this.fundingPollerInterval = null;
    }
    this.binanceWs?.removeAllListeners();
    this.bybitWs?.removeAllListeners();
    this.binanceWs?.close();
    this.bybitWs?.close();
    this.binanceWs = null;
    this.bybitWs = null;
  }
}
