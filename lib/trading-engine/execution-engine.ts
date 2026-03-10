/**
 * Phase 3.1: Private Execution Engine with Chunk System.
 * No CCXT. Direct REST for orders; WebSockets for private streams (order confirmation).
 */

import WebSocket from "ws";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionSettings {
  /** Capital to use as percentage of available balance (0–100). */
  capitalPercent: number;
  /** Min notional per chunk in USDT (e.g. 6). */
  minChunkNotional: number;
  /** Delay in ms after Bybit order before placing Binance (e.g. 10). */
  bybitToBinanceDelayMs: number;
  /** Fraction of orderbook first-row liquidity per subsequent chunk (e.g. 0.5 = 50%). */
  chunkLiquidityFraction: number;
}

export interface ExchangeCredentials {
  binance: { apiKey: string; apiSecret: string };
  bybit: { apiKey: string; apiSecret: string };
}

export interface OrderbookSnapshot {
  symbol: string;
  bids: [string, string][];
  asks: [string, string][];
}

export type OrderSide = "Long" | "Short";

export interface PlacedOrder {
  exchange: "binance" | "bybit";
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  filledQty?: number;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
}

export interface ChunkResult {
  success: boolean;
  bybitOrder?: PlacedOrder;
  binanceOrder?: PlacedOrder;
  error?: string;
  abortedBybit?: boolean;
  closedBybitAfterBinanceFail?: boolean;
}

// ---------------------------------------------------------------------------
// REST helpers: signing and base URLs
// ---------------------------------------------------------------------------

const BINANCE_BASE = "https://fapi.binance.com";
const BYBIT_BASE = "https://api.bybit.com";

function signBinance(secret: string, queryString: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

/** Bybit V5: sign sorted key=val& string (params + timestamp, recvWindow for REST). */
function signBybitV5(secret: string, params: Record<string, string | number>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

// ---------------------------------------------------------------------------
// Binance REST: listenKey, order, balance, leverage
// ---------------------------------------------------------------------------

export async function createBinanceListenKey(apiKey: string, apiSecret: string): Promise<string> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = signBinance(apiSecret, query);
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/listenKey?${query}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!res.ok) throw new Error(`Binance listenKey: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { listenKey?: string };
  if (!data.listenKey) throw new Error("Binance listenKey missing");
  return data.listenKey;
}

export async function placeBinanceOrder(
  apiKey: string,
  apiSecret: string,
  params: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "LIMIT";
    timeInForce: "IOC";
    quantity: string;
    price: string;
  }
): Promise<{ orderId: string; status: string }> {
  const timestamp = Date.now();
  const body = new URLSearchParams({
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    timeInForce: params.timeInForce,
    quantity: params.quantity,
    price: params.price,
    timestamp: String(timestamp),
  });
  const signature = signBinance(apiSecret, body.toString());
  body.append("signature", signature);
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/order`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json()) as { orderId?: number; status?: string; msg?: string };
  if (!res.ok) throw new Error(data.msg ?? `Binance order: ${res.status}`);
  return { orderId: String(data.orderId ?? ""), status: data.status ?? "UNKNOWN" };
}

export async function getBinanceBalance(apiKey: string, apiSecret: string): Promise<number> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = signBinance(apiSecret, query);
  const res = await fetch(`${BINANCE_BASE}/fapi/v2/balance?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!res.ok) throw new Error(`Binance balance: ${res.status}`);
  const arr = (await res.json()) as { asset: string; availableBalance: string }[];
  const usdt = arr.find((a) => a.asset === "USDT");
  return usdt ? parseFloat(usdt.availableBalance) : 0;
}

/** Returns max allowed leverage for symbol (from leverage bracket). */
export async function getBinanceLeverage(apiKey: string, apiSecret: string, symbol: string): Promise<number> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = signBinance(apiSecret, query);
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/leverageBracket?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!res.ok) throw new Error(`Binance leverage: ${res.status}`);
  const arr = (await res.json()) as { symbol: string; brackets: { initialLeverage: number }[] }[];
  const sym = arr.find((s) => s.symbol === symbol);
  if (!sym?.brackets?.length) return 1;
  return sym.brackets[0].initialLeverage ?? 1;
}

// ---------------------------------------------------------------------------
// Bybit REST: order, balance, leverage (instruments info)
// ---------------------------------------------------------------------------

export async function placeBybitOrder(
  apiKey: string,
  apiSecret: string,
  params: {
    symbol: string;
    side: "Buy" | "Sell";
    orderType: "Limit";
    timeInForce: "IOC";
    qty: string;
    price: string;
    category: "linear";
  }
): Promise<{ orderId: string; orderStatus: string }> {
  const timestamp = Date.now();
  const recvWindow = "5000";
  const body: Record<string, string> = {
    category: params.category,
    symbol: params.symbol,
    side: params.side,
    orderType: params.orderType,
    qty: params.qty,
    price: params.price,
    timeInForce: params.timeInForce,
    timestamp: String(timestamp),
    recvWindow,
  };
  const sign = signBybitV5(apiSecret, body);
  const res = await fetch(`${BYBIT_BASE}/v5/order/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { result?: { orderId?: string; orderStatus?: string }; retMsg?: string; retCode?: number };
  if (data.retCode !== 0 && data.retCode != null) throw new Error(data.retMsg ?? "Bybit order failed");
  if (!res.ok) throw new Error(`Bybit order: ${res.status}`);
  const result = data.result ?? {};
  return { orderId: result.orderId ?? "", orderStatus: result.orderStatus ?? "Unknown" };
}

export async function getBybitBalance(apiKey: string, apiSecret: string): Promise<number> {
  const timestamp = Date.now();
  const recvWindow = "5000";
  const params = { accountType: "UNIFIED", timestamp: String(timestamp), recvWindow };
  const sign = signBybitV5(apiSecret, params);
  const res = await fetch(`${BYBIT_BASE}/v5/account/wallet-balance/account-type?accountType=UNIFIED`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  if (!res.ok) throw new Error(`Bybit balance: ${res.status}`);
  const data = (await res.json()) as {
    result?: { list?: { totalEquity?: string; totalAvailableBalance?: string }[] };
  };
  const list = data.result?.list ?? [];
  const acc = list[0];
  const bal = acc?.totalAvailableBalance ?? acc?.totalEquity ?? "0";
  return parseFloat(bal);
}

/** Returns max leverage for linear symbol from instruments info. */
export async function getBybitLeverage(symbol: string): Promise<number> {
  const res = await fetch(
    `${BYBIT_BASE}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`
  );
  if (!res.ok) throw new Error(`Bybit instruments: ${res.status}`);
  const data = (await res.json()) as {
    result?: { list?: { symbol: string; leverageFilter?: { maxLeverage?: string } }[] };
  };
  const list = data.result?.list ?? [];
  const item = list.find((l) => l.symbol === symbol);
  const max = item?.leverageFilter?.maxLeverage;
  return max ? parseFloat(max) : 1;
}

// ---------------------------------------------------------------------------
// calculateLeverage: minimum of Binance and Bybit allowed leverage
// ---------------------------------------------------------------------------

export async function calculateLeverage(
  symbol: string,
  binanceApiKey: string,
  binanceApiSecret: string
): Promise<number> {
  const [binanceLev, bybitLev] = await Promise.all([
    getBinanceLeverage(binanceApiKey, binanceApiSecret, symbol),
    getBybitLeverage(symbol),
  ]);
  return Math.min(binanceLev, bybitLev);
}

// ---------------------------------------------------------------------------
// calculateQuantity: capital% from settings, lower balance exchange, L2 price
// ---------------------------------------------------------------------------

export function calculateQuantity(
  settings: ExecutionSettings,
  binanceAvailableUsdt: number,
  bybitAvailableUsdt: number,
  l2PriceBinance: number,
  l2PriceBybit: number,
  side: OrderSide
): { quantity: number; exchange: "binance" | "bybit"; notional: number } {
  const capPct = Math.max(0, Math.min(100, settings.capitalPercent)) / 100;
  const useBinance = binanceAvailableUsdt <= bybitAvailableUsdt;
  const balance = useBinance ? binanceAvailableUsdt : bybitAvailableUsdt;
  const price = useBinance ? l2PriceBinance : l2PriceBybit;
  if (price <= 0) return { quantity: 0, exchange: useBinance ? "binance" : "bybit", notional: 0 };
  const notional = balance * capPct;
  const quantity = notional / price;
  return { quantity, exchange: useBinance ? "binance" : "bybit", notional };
}

// ---------------------------------------------------------------------------
// Private WebSocket Manager: Binance (listenKey) + Bybit (auth)
// ---------------------------------------------------------------------------

const BINANCE_WS_BASE = "wss://fstream.binance.com/ws";
const BYBIT_WS_PRIVATE = "wss://stream.bybit.com/v5/private";

export interface PrivateWSManagerCallbacks {
  onBinanceOrderUpdate?: (orderId: string, status: string, filledQty: number) => void;
  onBybitOrderUpdate?: (orderId: string, status: string, filledQty: number) => void;
}

export class PrivateWSManager {
  private binanceWs: WebSocket | null = null;
  private bybitWs: WebSocket | null = null;
  private binanceListenKey: string | null = null;
  private credentials: ExchangeCredentials;
  private callbacks: PrivateWSManagerCallbacks = {};
  private orderConfirmations = new Map<
    string,
    { resolve: (filledQty: number) => void; reject: (err: Error) => void }
  >();

  constructor(credentials: ExchangeCredentials, callbacks?: PrivateWSManagerCallbacks) {
    this.credentials = credentials;
    if (callbacks) this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.binanceListenKey = await createBinanceListenKey(
      this.credentials.binance.apiKey,
      this.credentials.binance.apiSecret
    );
    this.binanceWs = new WebSocket(`${BINANCE_WS_BASE}/${this.binanceListenKey}`);
    this.binanceWs.on("message", (data: WebSocket.RawData) => this.handleBinanceMessage(data));
    this.binanceWs.on("error", (err) => console.error("[PrivateWS] Binance error:", err));

    this.bybitWs = new WebSocket(BYBIT_WS_PRIVATE);
    this.bybitWs.on("open", () => this.authBybit());
    this.bybitWs.on("message", (data: WebSocket.RawData) => this.handleBybitMessage(data));
    this.bybitWs.on("error", (err) => console.error("[PrivateWS] Bybit error:", err));
  }

  private authBybit(): void {
    if (!this.bybitWs) return;
    const expires = Date.now() + 10000;
    const signPayload = `GET/realtime${expires}`;
    const signature = crypto
      .createHmac("sha256", this.credentials.bybit.apiSecret)
      .update(signPayload)
      .digest("hex");
    this.bybitWs.send(
      JSON.stringify({
        op: "auth",
        args: [this.credentials.bybit.apiKey, String(expires), signature],
      })
    );
    this.bybitWs.send(JSON.stringify({ op: "subscribe", args: ["order"] }));
  }

  private handleBinanceMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString()) as { e?: string; o?: { i?: number; X?: string; z?: string } };
      if (msg.e === "ORDER_TRADE_UPDATE" && msg.o) {
        const o = msg.o;
        const orderId = String(o.i);
        const status = o.X ?? "";
        const filledQty = parseFloat(o.z ?? "0");
        this.callbacks.onBinanceOrderUpdate?.(orderId, status, filledQty);
        const pending = this.orderConfirmations.get(`binance:${orderId}`);
        if (pending && (status === "FILLED" || status === "PARTIALLY_FILLED" || status === "CANCELED" || status === "REJECTED")) {
          this.orderConfirmations.delete(`binance:${orderId}`);
          pending.resolve(filledQty);
        }
      }
    } catch (e) {
      console.error("[PrivateWS] Binance parse error:", e);
    }
  }

  private handleBybitMessage(data: WebSocket.RawData): void {
    try {
      const msg = JSON.parse(data.toString()) as {
        topic?: string;
        data?: { orderId?: string; orderStatus?: string; cumExecQty?: string };
      };
      if (msg.topic === "order" && msg.data) {
        const d = msg.data;
        const orderId = d.orderId ?? "";
        const status = d.orderStatus ?? "";
        const filledQty = parseFloat(d.cumExecQty ?? "0");
        this.callbacks.onBybitOrderUpdate?.(orderId, status, filledQty);
        const pending = this.orderConfirmations.get(`bybit:${orderId}`);
        if (pending && (status === "Filled" || status === "PartiallyFilled" || status === "Cancelled" || status === "Rejected")) {
          this.orderConfirmations.delete(`bybit:${orderId}`);
          pending.resolve(filledQty);
        }
      }
    } catch (e) {
      console.error("[PrivateWS] Bybit parse error:", e);
    }
  }

  /** Wait for order confirmation (fill or terminal state) with timeout. */
  waitForOrderConfirmation(exchange: "binance" | "bybit", orderId: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const key = `${exchange}:${orderId}`;
      const t = setTimeout(() => {
        if (this.orderConfirmations.has(key)) {
          this.orderConfirmations.delete(key);
          reject(new Error(`Order ${orderId} confirmation timeout`));
        }
      }, timeoutMs);
      this.orderConfirmations.set(key, {
        resolve: (filledQty) => {
          clearTimeout(t);
          resolve(filledQty);
        },
        reject: (err) => {
          clearTimeout(t);
          reject(err);
        },
      });
    });
  }

  stop(): void {
    this.binanceWs?.close();
    this.bybitWs?.close();
    this.binanceWs = null;
    this.bybitWs = null;
    this.orderConfirmations.forEach((p) => p.reject(new Error("PrivateWS closed")));
    this.orderConfirmations.clear();
  }
}

// ---------------------------------------------------------------------------
// Chunk system: first chunk min $6 Bybit -> 10ms + confirm -> Binance; rest 50% L1
// Limit IOC; price = best ask (long) / best bid (short). On Bybit fail abort; on Binance fail close Bybit leg.
// ---------------------------------------------------------------------------

const MIN_CHUNK_NOTIONAL = 6;
const DEFAULT_DELAY_MS = 10;
const CONFIRM_TIMEOUT_MS = 5000;

function getBestPrice(ob: OrderbookSnapshot, side: OrderSide): number {
  if (side === "Long") {
    const ask = ob.asks[0]?.[0];
    return ask ? parseFloat(ask) : 0;
  }
  const bid = ob.bids[0]?.[0];
  return bid ? parseFloat(bid) : 0;
}

function getFirstRowQty(ob: OrderbookSnapshot, side: OrderSide): number {
  if (side === "Long") {
    const q = ob.asks[0]?.[1];
    return q ? parseFloat(q) : 0;
  }
  const q = ob.bids[0]?.[1];
  return q ? parseFloat(q) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function executeChunkTrade(
  symbol: string,
  side: OrderSide,
  orderbook: OrderbookSnapshot,
  settings: ExecutionSettings,
  credentials: ExchangeCredentials,
  privateWs: PrivateWSManager,
  binanceBalance: number,
  bybitBalance: number,
  binanceL2Price: number,
  bybitL2Price: number
): Promise<ChunkResult[]> {
  const results: ChunkResult[] = [];
  const minNotional = Math.max(settings.minChunkNotional ?? MIN_CHUNK_NOTIONAL, MIN_CHUNK_NOTIONAL);
  const delayMs = settings.bybitToBinanceDelayMs ?? DEFAULT_DELAY_MS;
  const frac = Math.max(0.01, Math.min(1, settings.chunkLiquidityFraction ?? 0.5));

  const isBuy = side === "Long";
  const binanceSide = isBuy ? "BUY" : "SELL";
  const bybitSide = isBuy ? "Buy" : "Sell";
  const priceBybit = getBestPrice(orderbook, side);
  const priceBinance = getBestPrice(orderbook, side);
  if (priceBybit <= 0 || priceBinance <= 0) {
    results.push({ success: false, error: "No orderbook price" });
    return results;
  }

  // First chunk: min $6 notional on Bybit -> wait 10ms + confirm -> Binance
  const firstChunkQty = minNotional / priceBybit;
  let bybitOrderId: string | null = null;

  try {
    const bybitRes = await placeBybitOrder(
      credentials.bybit.apiKey,
      credentials.bybit.apiSecret,
      {
        symbol,
        side: bybitSide,
        orderType: "Limit",
        timeInForce: "IOC",
        qty: firstChunkQty.toFixed(8),
        price: priceBybit.toFixed(8),
        category: "linear",
      }
    );
    bybitOrderId = bybitRes.orderId;
    if (!bybitOrderId || bybitRes.orderStatus === "Rejected") {
      results.push({ success: false, error: "Bybit first chunk rejected", bybitOrder: { exchange: "bybit", orderId: bybitRes.orderId, symbol, side, quantity: firstChunkQty, price: priceBybit, status: "REJECTED" } });
      return results;
    }

    await sleep(delayMs);
    const filledBybit = await privateWs.waitForOrderConfirmation("bybit", bybitOrderId, CONFIRM_TIMEOUT_MS);

    const binanceRes = await placeBinanceOrder(
      credentials.binance.apiKey,
      credentials.binance.apiSecret,
      {
        symbol,
        side: binanceSide,
        type: "LIMIT",
        timeInForce: "IOC",
        quantity: String(filledBybit > 0 ? filledBybit : firstChunkQty),
        price: priceBinance.toFixed(8),
      }
    ).catch(async (err) => {
      await placeBybitOrder(credentials.bybit.apiKey, credentials.bybit.apiSecret, {
        symbol,
        side: bybitSide === "Buy" ? "Sell" : "Buy",
        orderType: "Limit",
        timeInForce: "IOC",
        qty: String(filledBybit > 0 ? filledBybit : firstChunkQty),
        price: priceBybit.toFixed(8),
        category: "linear",
      }).catch(() => {});
      throw err;
    });

    results.push({
      success: true,
      bybitOrder: { exchange: "bybit", orderId: bybitOrderId!, symbol, side, quantity: firstChunkQty, price: priceBybit, filledQty: filledBybit, status: "FILLED" },
      binanceOrder: { exchange: "binance", orderId: binanceRes.orderId, symbol, side, quantity: firstChunkQty, price: priceBinance, status: binanceRes.status as PlacedOrder["status"] },
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    results.push({
      success: false,
      error: errMsg,
      bybitOrder: bybitOrderId
        ? { exchange: "bybit", orderId: bybitOrderId, symbol, side, quantity: firstChunkQty, price: priceBybit, status: "FILLED" as const }
        : undefined,
      closedBybitAfterBinanceFail: !!bybitOrderId,
    });
    return results;
  }

  // Remaining chunks: 50% of orderbook first row each; same flow (Bybit -> delay+confirm -> Binance)
  const firstRowQty = getFirstRowQty(orderbook, side);
  const chunkQty = firstRowQty * frac;
  if (chunkQty <= 0) return results;

  for (let i = 0; i < 10; i++) {
    const priceBybitNext = getBestPrice(orderbook, side);
    const priceBinanceNext = getBestPrice(orderbook, side);
    if (priceBybitNext <= 0 || priceBinanceNext <= 0) break;

    let bybitId: string | null = null;
    try {
      const resBybit = await placeBybitOrder(
        credentials.bybit.apiKey,
        credentials.bybit.apiSecret,
        {
          symbol,
          side: bybitSide,
          orderType: "Limit",
          timeInForce: "IOC",
          qty: chunkQty.toFixed(8),
          price: priceBybitNext.toFixed(8),
          category: "linear",
        }
      );
      bybitId = resBybit.orderId;
      if (!bybitId || resBybit.orderStatus === "Rejected") {
        results.push({ success: false, error: "Bybit chunk rejected", abortedBybit: true });
        break;
      }
      await sleep(delayMs);
      const filled = await privateWs.waitForOrderConfirmation("bybit", bybitId, CONFIRM_TIMEOUT_MS);

      await placeBinanceOrder(credentials.binance.apiKey, credentials.binance.apiSecret, {
        symbol,
        side: binanceSide,
        type: "LIMIT",
        timeInForce: "IOC",
        quantity: String(filled > 0 ? filled : chunkQty),
        price: priceBinanceNext.toFixed(8),
      });

      results.push({
        success: true,
        bybitOrder: { exchange: "bybit", orderId: bybitId, symbol, side, quantity: chunkQty, price: priceBybitNext, filledQty: filled, status: "FILLED" },
        binanceOrder: { exchange: "binance", orderId: "", symbol, side, quantity: chunkQty, price: priceBinanceNext, status: "FILLED" },
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      results.push({
        success: false,
        error: errMsg,
        closedBybitAfterBinanceFail: !!bybitId,
      });
      break;
    }
  }

  return results;
}
