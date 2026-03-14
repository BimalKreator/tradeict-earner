/**
 * Phase 3.1: Private Execution Engine with Chunk System.
 * No CCXT. Direct REST for orders; WebSockets for private streams (order confirmation).
 */

import WebSocket from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { reportBinanceBan, reportBybitBan, parseBanUntilFromError } from "./system-state";

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
  /** Enable auto-exit monitor (SL/TP and orphan exit). */
  autoExit?: boolean;
  /** Stoploss as percentage of margin (e.g. 2 = 2%). */
  stoplossPercent?: number;
  /** Take-profit as percentage of margin (e.g. 1.5 = 1.5%). */
  targetPercent?: number;
  /** Slippage tolerance as percentage (e.g. 0.05 = 0.05%). */
  slippagePercent?: number;
  /** Total fees as percentage of trade value (e.g. 0.1 = 0.1%). */
  feesPercent?: number;
  /** Leverage (e.g. 3). */
  leverage?: number;
  /** Override: use this quantity instead of balance-based target (manual trade). */
  manualQuantity?: number;
  /** Max number of concurrent trade slots (for auto-trade). */
  maxTradeSlot?: number;
  /** Enable auto-trade loop (server fills slots from screener). */
  autoTrade?: boolean;
  /** User email whose API keys to use for auto-trade when no manual trade has run yet. */
  autoTradeUserEmail?: string;
  /** How to compute unrealized PnL and Target/SL: L2 VWAP (avg price over 2x qty) or orderbook price at 2x qty level. */
  pnlCalculationMethod?: "L2_VWAP" | "ORDERBOOK_DOUBLE_QTY";
  /** Auto-exit when funding flips: exit if PnL > 0, or force-exit if ≤10m to next funding. */
  fundingFlipExit?: boolean;
  /** Fixed capital (USDT) per trade when > 0; otherwise fallback to capitalPercent. */
  fixedCapitalPerTrade?: number;
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

/** Single exchange position (raw from API). */
export interface RawPosition {
  exchange: "binance" | "bybit";
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  /** Initial/margin used (USD) for this position. */
  marginUsed: number;
}

// ---------------------------------------------------------------------------
// REST helpers: signing and base URLs
// ---------------------------------------------------------------------------

const BINANCE_BASE = "https://fapi.binance.com";
const BYBIT_BASE = "https://api.bybit.com";

function signBinance(secret: string, queryString: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

/** Bybit V5: sign sorted key=val& string (params + timestamp, recvWindow for REST). Used for POST and some GET. */
function signBybitV5(secret: string, params: Record<string, string | number>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

/**
 * Bybit V5 GET: sign string = timestamp + api_key + recv_window + queryString.
 * queryString must be exactly the URL query part (e.g. accountType=UNIFIED&coin=USDT).
 * Ref: https://bybit-exchange.github.io/docs/v5/guide
 */
function signBybitV5Get(
  secret: string,
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryString: string
): string {
  const originString = timestamp + apiKey + recvWindow + queryString;
  return crypto.createHmac("sha256", secret).update(originString).digest("hex");
}

// ---------------------------------------------------------------------------
// Binance REST: listenKey, order, balance, leverage
// ---------------------------------------------------------------------------

const BINANCE_LISTENKEY_CACHE_MS = 30 * 60 * 1000; // 30 minutes (Binance allows up to 60)
let cachedListenKey: string | null = null;
let listenKeyTimestamp = 0;
let listenKeyApiKey = "";

export async function createBinanceListenKey(apiKey: string, apiSecret: string): Promise<string> {
  const now = Date.now();
  if (cachedListenKey && listenKeyApiKey === apiKey && now - listenKeyTimestamp < BINANCE_LISTENKEY_CACHE_MS) {
    return cachedListenKey;
  }
  const timestamp = now;
  const query = `timestamp=${timestamp}`;
  const signature = signBinance(apiSecret, query);
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/listenKey?${query}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 418 || res.status === 429) reportBinanceBan(parseBanUntilFromError(res.status, text));
    throw new Error(`Binance listenKey: ${res.status} ${text}`);
  }
  const data = JSON.parse(text) as { listenKey?: string };
  if (!data.listenKey) throw new Error("Binance listenKey missing");
  cachedListenKey = data.listenKey;
  listenKeyTimestamp = Date.now();
  listenKeyApiKey = apiKey;
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
    reduceOnly?: boolean;
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
  if (params.reduceOnly === true) body.append("reduceOnly", "true");
  const signature = signBinance(apiSecret, body.toString());
  body.append("signature", signature);
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/order`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 418 || res.status === 429) reportBinanceBan(parseBanUntilFromError(res.status, text));
    let errMsg = text;
    try {
      const parsed = JSON.parse(text) as { msg?: string };
      if (parsed.msg) errMsg = parsed.msg;
    } catch {}
    throw new Error(errMsg || `Binance order: ${res.status}`);
  }
  const data = JSON.parse(text) as { orderId?: number; status?: string; msg?: string };
  return { orderId: String(data.orderId ?? ""), status: data.status ?? "UNKNOWN" };
}

export interface BalanceMetrics {
  total: number;
  used: number;
  available: number;
}

/** Fetch balance metrics from Binance USDT-M futures: /fapi/v2/account. */
export async function getBinanceBalance(apiKey: string, apiSecret: string): Promise<BalanceMetrics> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = signBinance(apiSecret, query);
  const res = await fetch(`${BINANCE_BASE}/fapi/v2/account?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 418 || res.status === 429) reportBinanceBan(parseBanUntilFromError(res.status, text));
    throw new Error(`Binance account: ${res.status} ${text}`);
  }
  const data = JSON.parse(text) as {
    totalMarginBalance?: string;
    totalInitialMargin?: string;
    availableBalance?: string;
  };
  return {
    total: parseFloat(data.totalMarginBalance ?? "0") || 0,
    used: parseFloat(data.totalInitialMargin ?? "0") || 0,
    available: parseFloat(data.availableBalance ?? "0") || 0,
  };
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

/** Fetch open positions from Binance USDT-M futures (fapi = USDT-margined). Only active positions (size !== 0) and symbol ending USDT for dashboard consistency. */
export async function getBinancePositions(apiKey: string, apiSecret: string): Promise<RawPosition[]> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = signBinance(apiSecret, query);
  const res = await fetch(`${BINANCE_BASE}/fapi/v2/positionRisk?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 418 || res.status === 429) reportBinanceBan(parseBanUntilFromError(res.status, text));
    throw new Error(`Binance positions: ${res.status} ${text}`);
  }
  const arr = JSON.parse(text) as {
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    liquidationPrice: string;
    unRealizedProfit: string;
    positionSide: string;
    notional?: string;
    leverage?: string;
  }[];
  const out: RawPosition[] = [];
  for (const p of arr) {
    const amt = parseFloat(p.positionAmt);
    if (amt === 0) continue;
    if (!p.symbol || !p.symbol.endsWith("USDT")) continue;
    const side: OrderSide = amt > 0 ? "Long" : "Short";
    const symbol = p.symbol.toUpperCase();
    const mark = parseFloat(p.markPrice) || 0;
    const qty = Math.abs(amt);
    const notional = Math.abs(parseFloat(p.notional ?? "0") || 0) || qty * mark;
    const leverage = parseFloat(p.leverage ?? "1") || 1;
    const marginUsed = leverage > 0 ? notional / leverage : notional;
    out.push({
      exchange: "binance",
      symbol,
      side,
      quantity: Math.abs(amt),
      entryPrice: parseFloat(p.entryPrice) || 0,
      markPrice: parseFloat(p.markPrice) || 0,
      liquidationPrice: parseFloat(p.liquidationPrice) || 0,
      unrealizedPnl: parseFloat(p.unRealizedProfit) || 0,
      marginUsed,
    });
  }
  return out;
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
    reduceOnly?: boolean;
  }
): Promise<{ orderId: string; orderStatus: string }> {
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const body: Record<string, string | boolean> = {
    category: params.category,
    symbol: params.symbol,
    side: params.side,
    orderType: params.orderType,
    qty: params.qty,
    price: params.price,
    timeInForce: params.timeInForce,
  };
  if (params.reduceOnly === true) body.reduceOnly = true;
  const payloadString = JSON.stringify(body);
  const signString = timestamp + apiKey + recvWindow + payloadString;
  const sign = crypto.createHmac("sha256", apiSecret).update(signString).digest("hex");
  const res = await fetch(`${BYBIT_BASE}/v5/order/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
    body: payloadString,
  });
  const text = await res.text();
  if (res.status === 418 || res.status === 429) reportBybitBan(parseBanUntilFromError(res.status, text));
  const data = JSON.parse(text) as { result?: { orderId?: string; orderStatus?: string }; retMsg?: string; retCode?: number };
  if (data.retCode !== 0 && data.retCode != null) throw new Error(data.retMsg ?? "Bybit order failed");
  if (!res.ok) throw new Error(`Bybit order: ${res.status} ${text}`);
  const result = data.result ?? {};
  return { orderId: result.orderId ?? "", orderStatus: result.orderStatus ?? "Unknown" };
}

async function fetchBybitBalanceWithAccountType(
  apiKey: string,
  apiSecret: string,
  accountType: "UNIFIED" | "CONTRACT"
): Promise<BalanceMetrics> {
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const queryString = `accountType=${accountType}&coin=USDT`;
  const sign = signBybitV5Get(apiSecret, timestamp, apiKey, recvWindow, queryString);
  const res = await fetch(`${BYBIT_BASE}/v5/account/wallet-balance?${queryString}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  const text = await res.text();
  if (res.status === 418 || res.status === 429) reportBybitBan(parseBanUntilFromError(res.status, text));
  const data = JSON.parse(text) as {
    retCode?: number;
    retMsg?: string;
    result?: {
      list?: {
        totalEquity?: string;
        totalInitialMargin?: string;
        totalAvailableBalance?: string;
      }[];
    };
  };
  if (data.retCode !== 0 && data.retCode != null) {
    throw new Error(data.retMsg ?? `Bybit balance: ${data.retCode}`);
  }
  if (!res.ok) throw new Error(`Bybit balance: ${res.status} ${text}`);
  const list = data.result?.list ?? [];
  const acc = list[0];
  const total = parseFloat(acc?.totalEquity ?? "0") || 0;
  const used = parseFloat(acc?.totalInitialMargin ?? "0") || 0;
  const available = parseFloat(acc?.totalAvailableBalance ?? "0") || 0;
  return { total, used, available };
}

/** Fetch balance metrics from Bybit UNIFIED wallet (v5/account/wallet-balance). */
export async function getBybitBalance(apiKey: string, apiSecret: string): Promise<BalanceMetrics> {
  return fetchBybitBalanceWithAccountType(apiKey, apiSecret, "UNIFIED");
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

/** Fetch open positions from Bybit linear USDT (USD-margined futures only). category=linear + settleCoin=USDT; only active (size > 0). */
export async function getBybitPositions(apiKey: string, apiSecret: string): Promise<RawPosition[]> {
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const params: Record<string, string> = {
    category: "linear",
    settleCoin: "USDT",
    timestamp,
    recvWindow,
  };
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const sign = signBybitV5Get(apiSecret, timestamp, apiKey, recvWindow, qs);
  const res = await fetch(`${BYBIT_BASE}/v5/position/list?${qs}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 418 || res.status === 429) reportBybitBan(parseBanUntilFromError(res.status, text));
    throw new Error(`Bybit positions: ${res.status} ${text}`);
  }
  const data = JSON.parse(text) as {
    retCode?: number;
    result?: {
      list?: {
        symbol: string;
        side: string;
        size: string;
        avgPrice: string;
        markPrice: string;
        liqPrice: string;
        unrealisedPnl: string;
        positionIM?: string;
      }[];
    };
  };
  if (data.retCode !== 0 && data.retCode != null) throw new Error("Bybit positions: " + (data as { retMsg?: string }).retMsg);
  const list = data.result?.list ?? [];
  const out: RawPosition[] = [];
  for (const p of list) {
    const size = parseFloat(p.size);
    if (size <= 0) continue;
    const side: OrderSide = p.side === "Buy" ? "Long" : "Short";
    const symbol = (p.symbol || "").toUpperCase();
    const marginUsed = parseFloat(p.positionIM ?? "0") || 0;
    out.push({
      exchange: "bybit",
      symbol,
      side,
      quantity: size,
      entryPrice: parseFloat(p.avgPrice) || 0,
      markPrice: parseFloat(p.markPrice) || 0,
      liquidationPrice: parseFloat(p.liqPrice || "0") || 0,
      unrealizedPnl: parseFloat(p.unrealisedPnl || "0") || 0,
      marginUsed,
    });
  }
  return out;
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

const MAX_ORDER_BUFFER = 100;

function isTerminalStatus(exchange: "binance" | "bybit", status: string): boolean {
  if (exchange === "binance") {
    return status === "FILLED" || status === "PARTIALLY_FILLED" || status === "CANCELED" || status === "REJECTED";
  }
  return status === "Filled" || status === "PartiallyFilled" || status === "Cancelled" || status === "Rejected";
}

export interface PrivateWSManagerCallbacks {
  onBinanceOrderUpdate?: (orderId: string, status: string, filledQty: number) => void;
  onBybitOrderUpdate?: (orderId: string, status: string, filledQty: number) => void;
}

interface OrderBufferEntry {
  key: string;
  exchange: "binance" | "bybit";
  orderId: string;
  symbol?: string;
  status: string;
  filledQty: number;
  ts: number;
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
  private orderBuffer: OrderBufferEntry[] = [];

  constructor(credentials: ExchangeCredentials, callbacks?: PrivateWSManagerCallbacks) {
    this.credentials = credentials;
    if (callbacks) this.callbacks = callbacks;
  }

  /** True if both Binance and Bybit private WebSockets are open (for persistent HFT use). */
  isConnected(): boolean {
    return this.binanceWs?.readyState === 1 && this.bybitWs?.readyState === 1;
  }

  private pushToOrderBuffer(
    exchange: "binance" | "bybit",
    orderId: string,
    symbol: string | undefined,
    status: string,
    filledQty: number
  ): void {
    const key = `${exchange}:${orderId}`;
    this.orderBuffer.push({ key, exchange, orderId, symbol, status, filledQty, ts: Date.now() });
    while (this.orderBuffer.length > MAX_ORDER_BUFFER) this.orderBuffer.shift();
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
      const msg = JSON.parse(data.toString()) as {
        e?: string;
        o?: { i?: number; X?: string; z?: string; s?: string };
      };
      if (msg.e === "ORDER_TRADE_UPDATE" && msg.o) {
        const o = msg.o;
        const orderId = String(o.i);
        const status = o.X ?? "";
        const filledQty = parseFloat(o.z ?? "0");
        const symbol = o.s;
        this.pushToOrderBuffer("binance", orderId, symbol, status, filledQty);
        this.callbacks.onBinanceOrderUpdate?.(orderId, status, filledQty);
        const pending = this.orderConfirmations.get(`binance:${orderId}`);
        if (pending && isTerminalStatus("binance", status)) {
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
        data?: { orderId?: string; orderStatus?: string; cumExecQty?: string; symbol?: string };
      };
      if (msg.topic === "order" && msg.data) {
        const d = msg.data;
        const orderId = d.orderId ?? "";
        const status = d.orderStatus ?? "";
        const filledQty = parseFloat(d.cumExecQty ?? "0");
        const symbol = d.symbol;
        this.pushToOrderBuffer("bybit", orderId, symbol, status, filledQty);
        this.callbacks.onBybitOrderUpdate?.(orderId, status, filledQty);
        const pending = this.orderConfirmations.get(`bybit:${orderId}`);
        if (pending && isTerminalStatus("bybit", status)) {
          this.orderConfirmations.delete(`bybit:${orderId}`);
          pending.resolve(filledQty);
        }
      }
    } catch (e) {
      console.error("[PrivateWS] Bybit parse error:", e);
    }
  }

  /** Wait for order confirmation (fill or terminal state). Checks buffer first (0ms), then waits up to timeoutMs, then REST fallback. */
  waitForOrderConfirmation(
    exchange: "binance" | "bybit",
    orderId: string,
    timeoutMs: number,
    symbol?: string
  ): Promise<number> {
    const key = `${exchange}:${orderId}`;
    const start = Date.now();

    // Instant buffer check (0ms)
    const buf = this.orderBuffer.find((e) => e.key === key);
    if (buf && isTerminalStatus(buf.exchange, buf.status)) {
      const elapsed = Date.now() - start;
      console.log(`[CHUNK-SYSTEM] Order ${orderId} confirmed in ${elapsed}ms (WS-Buffer)`);
      return Promise.resolve(buf.filledQty);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: number) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const t = setTimeout(async () => {
        if (!this.orderConfirmations.has(key)) return;
        this.orderConfirmations.delete(key);
        const elapsed = Date.now() - start;
        try {
          if (exchange === "bybit") {
            const filled = await this.fetchBybitOrderStatus(orderId);
            console.log(`[CHUNK-SYSTEM] Order ${orderId} confirmed in ${elapsed}ms (REST-Fallback)`);
            safeResolve(Number(filled) || 0);
          } else {
            if (!symbol) {
              safeReject(new Error(`Order ${orderId} confirmation timeout (REST fallback requires symbol)`));
              return;
            }
            const filled = await this.fetchBinanceOrderStatus(symbol, orderId);
            console.log(`[CHUNK-SYSTEM] Order ${orderId} confirmed in ${elapsed}ms (REST-Fallback)`);
            safeResolve(Number(filled) || 0);
          }
        } catch (e) {
          safeReject(e instanceof Error ? e : new Error(String(e)));
        }
      }, timeoutMs);

      this.orderConfirmations.set(key, {
        resolve: (filledQty) => {
          clearTimeout(t);
          if (settled) return;
          settled = true;
          const elapsed = Date.now() - start;
          console.log(`[CHUNK-SYSTEM] Order ${orderId} confirmed in ${elapsed}ms (WS-Live)`);
          resolve(filledQty);
        },
        reject: (err) => {
          clearTimeout(t);
          if (settled) return;
          settled = true;
          reject(err);
        },
      });
    });
  }

  private async fetchBybitOrderStatus(orderId: string): Promise<number> {
    const timestamp = String(Date.now());
    const recvWindow = "5000";

    const queryString = `category=linear&orderId=${encodeURIComponent(orderId)}`;
    const sign = signBybitV5Get(
      this.credentials.bybit.apiSecret,
      timestamp,
      this.credentials.bybit.apiKey,
      recvWindow,
      queryString
    );

    // Check execution list for instant fills
    const res = await fetch(`${BYBIT_BASE}/v5/execution/list?${queryString}`, {
      headers: {
        "X-BAPI-API-KEY": this.credentials.bybit.apiKey,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });
    const data = await res.json();

    let totalFilled = 0;
    if (data?.result?.list && Array.isArray(data.result.list)) {
      for (const exec of data.result.list) {
        totalFilled += Number(exec.execQty || 0);
      }
    }

    if (totalFilled === 0) {
      // Order didn't fill. Let's find out exactly why from the history endpoint.
      const histSign = signBybitV5Get(this.credentials.bybit.apiSecret, timestamp, this.credentials.bybit.apiKey, recvWindow, queryString);
      const histRes = await fetch(`${BYBIT_BASE}/v5/order/history?${queryString}`, {
        headers: {
          "X-BAPI-API-KEY": this.credentials.bybit.apiKey,
          "X-BAPI-SIGN": histSign,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });
      const histData = await histRes.json();

      if (histData?.result?.list?.length > 0) {
        const order = histData.result.list[0];
        console.log(`[CHUNK-SYSTEM] Bybit order ${orderId} failed to fill. Status: ${order.orderStatus}, Reject Reason: ${order.rejectReason || "None"}`);
      } else {
        const rtRes = await fetch(`${BYBIT_BASE}/v5/order/realtime?${queryString}`, {
          headers: {
            "X-BAPI-API-KEY": this.credentials.bybit.apiKey,
            "X-BAPI-SIGN": histSign,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recvWindow,
          },
        });
        const rtData = await rtRes.json();
        if (rtData?.result?.list?.length > 0) {
          const rtOrder = rtData.result.list[0];
          console.log(`[CHUNK-SYSTEM] Bybit order ${orderId} found in realtime. Status: ${rtOrder.orderStatus}, Reject Reason: ${rtOrder.rejectReason || "None"}`);
        } else {
          console.log(`[CHUNK-SYSTEM] Bybit order ${orderId} missing everywhere (Execution, History, Realtime). This usually means Price out of bounds or Insufficient Margin.`);
        }
      }
    } else {
      console.log(`[CHUNK-SYSTEM] Bybit order ${orderId} execution list total filled: ${totalFilled}`);
    }

    return totalFilled;
  }

  private async fetchBinanceOrderStatus(symbol: string, orderId: string): Promise<number> {
    const timestamp = Date.now();
    const query = `symbol=${encodeURIComponent(symbol)}&orderId=${orderId}&timestamp=${timestamp}`;
    const signature = signBinance(this.credentials.binance.apiSecret, query);
    const res = await fetch(`${BINANCE_BASE}/fapi/v1/order?${query}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": this.credentials.binance.apiKey },
    });
    const data = await res.json();
    if (!data || data.code || data.msg || data.executedQty == null) return 0;
    return Number(data.executedQty);
  }

  stop(): void {
    try {
      this.binanceWs?.close();
    } catch {
      // Ignore if connection already dead
    }
    try {
      this.bybitWs?.close();
    } catch {
      // Ignore if connection already dead
    }
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
const CONFIRM_TIMEOUT_MS = 400;

const binanceStepSizeCache = new Map<string, number>();
const bybitStepSizeCache = new Map<string, number>();
const binanceTickSizeCache = new Map<string, number>();
const bybitTickSizeCache = new Map<string, number>();

export async function getBinanceStepSize(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const cached = binanceStepSizeCache.get(key);
  if (cached != null) return cached;
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(key)}`);
  if (!res.ok) return 0.001;
  const data = (await res.json()) as { symbols?: { symbol: string; filters?: { filterType: string; stepSize?: string; tickSize?: string }[] }[] };
  const sym = data.symbols?.find((s) => s.symbol === key);
  const lotSize = sym?.filters?.find((f) => f.filterType === "LOT_SIZE");
  const step = lotSize?.stepSize ? parseFloat(lotSize.stepSize) : 0.001;
  const stepSize = Number.isFinite(step) && step > 0 ? step : 0.001;
  binanceStepSizeCache.set(key, stepSize);
  return stepSize;
}

export async function getBybitStepSize(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const cached = bybitStepSizeCache.get(key);
  if (cached != null) return cached;
  const res = await fetch(
    `${BYBIT_BASE}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(key)}`
  );
  if (!res.ok) return 0.001;
  const data = (await res.json()) as {
    result?: { list?: { symbol: string; lotSizeFilter?: { qtyStep?: string }; priceFilter?: { tickSize?: string } }[] };
  };
  const item = data.result?.list?.find((l) => l.symbol === key);
  const qtyStep = item?.lotSizeFilter?.qtyStep ? parseFloat(item.lotSizeFilter.qtyStep) : 0.001;
  const stepSize = Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep : 0.001;
  bybitStepSizeCache.set(key, stepSize);
  return stepSize;
}

export async function getBinanceTickSize(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const cached = binanceTickSizeCache.get(key);
  if (cached != null) return cached;
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(key)}`);
  if (!res.ok) return 0.01;
  const data = (await res.json()) as { symbols?: { symbol: string; filters?: { filterType: string; tickSize?: string }[] }[] };
  const sym = data.symbols?.find((s) => s.symbol === key);
  const priceFilter = sym?.filters?.find((f) => f.filterType === "PRICE_FILTER");
  const tick = priceFilter?.tickSize ? parseFloat(priceFilter.tickSize) : 0.01;
  const tickSize = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  binanceTickSizeCache.set(key, tickSize);
  return tickSize;
}

export async function getBybitTickSize(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const cached = bybitTickSizeCache.get(key);
  if (cached != null) return cached;
  const res = await fetch(
    `${BYBIT_BASE}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(key)}`
  );
  if (!res.ok) return 0.01;
  const data = (await res.json()) as {
    result?: { list?: { symbol: string; priceFilter?: { tickSize?: string } }[] };
  };
  const item = data.result?.list?.find((l) => l.symbol === key);
  const tick = item?.priceFilter?.tickSize ? parseFloat(item.priceFilter.tickSize) : 0.01;
  const tickSize = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  bybitTickSizeCache.set(key, tickSize);
  return tickSize;
}

export async function getBybitOrderbookFast(symbol: string): Promise<{ bestBid: number; bestAsk: number }> {
  try {
    const res = await fetch(
      `${BYBIT_BASE}/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(symbol)}&limit=1`
    );
    const data = await res.json();
    const b = data.result?.b?.[0]?.[0];
    const a = data.result?.a?.[0]?.[0];
    return { bestBid: b ? parseFloat(b) : 0, bestAsk: a ? parseFloat(a) : 0 };
  } catch {
    return { bestBid: 0, bestAsk: 0 };
  }
}

/**
 * Truncate quantity to a multiple of stepSize (round down) and return string without scientific notation.
 */
export function formatQuantity(qty: number, stepSize: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return "0";
  if (!Number.isFinite(stepSize) || stepSize <= 0) stepSize = 0.001;
  const truncated = Math.floor(qty / stepSize) * stepSize;
  if (truncated <= 0) return "0";
  const stepStr = stepSize.toString();
  const decimals = stepStr.includes("e")
    ? 8
    : (stepStr.split(".")[1]?.length ?? 8);
  const s = truncated.toFixed(decimals);
  return s.includes("e") ? truncated.toLocaleString("en", { maximumFractionDigits: 8 }) : s;
}

/** Preserve significant digits up to 8 decimal places; strip trailing zeros. Use when tickSize would round price to 0. */
function formatPriceDynamic(rawPrice: number): string {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return String(rawPrice);
  return Number(rawPrice).toFixed(8).replace(/\.?0+$/, "") || "0";
}

function formatPrice(price: number, tickSize: number): string {
  if (!Number.isFinite(price) || price <= 0) return "0";
  if (!tickSize || tickSize <= 0) return formatPriceDynamic(price);
  const rounded = Math.round(price / tickSize) * tickSize;
  if (rounded <= 0) return formatPriceDynamic(price);
  const tickStr = tickSize.toString();
  const decimals = tickStr.includes("e")
    ? 8
    : (tickStr.split(".")[1]?.length ?? 8);
  const formatted = rounded.toFixed(decimals);
  return formatted.includes("e") ? formatPriceDynamic(rounded) : formatted;
}

function ensurePriceValid(formattedPrice: string, rawPrice: number, label: string): void {
  const num = Number(formattedPrice);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label}: Invalid price formatted: ${formattedPrice} (Raw: ${rawPrice})`);
  }
}

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
  bybitL2Price: number,
  onProgress?: (message: string) => void,
  isExit?: boolean
): Promise<ChunkResult[]> {
  const P = "[CHUNK-SYSTEM]";
  const reduceOnly = !!isExit;
  const results: ChunkResult[] = [];
  const minNotional = Math.max(settings.minChunkNotional ?? MIN_CHUNK_NOTIONAL, MIN_CHUNK_NOTIONAL);
  const delayMs = settings.bybitToBinanceDelayMs ?? DEFAULT_DELAY_MS;
  const frac = Math.max(0.01, Math.min(1, settings.chunkLiquidityFraction ?? 0.5));

  console.log(`${P} Starting chunk trade: symbol=${symbol} side=${side} minChunkNotional=$${minNotional} liquidityFraction=${frac} reduceOnly=${reduceOnly}`);
  onProgress?.("Starting trade…");

  const [bybitStepSize, binanceStepSize, bybitTickSize, binanceTickSize] = await Promise.all([
    getBybitStepSize(symbol),
    getBinanceStepSize(symbol),
    getBybitTickSize(symbol),
    getBinanceTickSize(symbol),
  ]);
  console.log(`${P} Step sizes: Bybit=${bybitStepSize} Binance=${binanceStepSize}`);

  let isBinanceBuy = true;
  let isBybitBuy = false;
  if (side.includes("Short Binance")) {
    isBinanceBuy = false;
    isBybitBuy = true;
  } else if (side.includes("Long Binance")) {
    isBinanceBuy = true;
    isBybitBuy = false;
  } else if (side === "Long") {
    isBinanceBuy = true;
    isBybitBuy = false;
  } else if (side === "Short") {
    isBinanceBuy = false;
    isBybitBuy = true;
  }
  const binanceSide = isBinanceBuy ? "BUY" : "SELL";
  const bybitSide = isBybitBuy ? "Buy" : "Sell";

  const bybitOrderbookSide: OrderSide = isBybitBuy ? "Long" : "Short";
  const binanceOrderbookSide: OrderSide = isBinanceBuy ? "Long" : "Short";

  const priceBybitBase = getBestPrice(orderbook, bybitOrderbookSide);
  const priceBinanceBase = getBestPrice(orderbook, binanceOrderbookSide);

  if (priceBybitBase <= 0 || priceBinanceBase <= 0) {
    console.log(`${P} Abort: no orderbook price (Bybit=${priceBybitBase} Binance=${priceBinanceBase})`);
    onProgress?.("Trade failed: No orderbook price");
    results.push({ success: false, error: "No orderbook price" });
    return results;
  }

  const slipPct = (settings.slippagePercent ?? 0.05) / 100;
  const execPriceBybitRaw = isBybitBuy ? priceBybitBase * (1 + slipPct) : priceBybitBase * (1 - slipPct);
  const execPriceBinanceRaw = isBinanceBuy ? priceBinanceBase * (1 + slipPct) : priceBinanceBase * (1 - slipPct);

  const execPriceBybit = formatPrice(execPriceBybitRaw, bybitTickSize);
  const execPriceBinance = formatPrice(execPriceBinanceRaw, binanceTickSize);
  ensurePriceValid(execPriceBybit, execPriceBybitRaw, "Bybit");
  ensurePriceValid(execPriceBinance, execPriceBinanceRaw, "Binance");

  // Dynamic Leverage: Pick the minimum allowed between user settings and both exchanges
  const maxAllowedLev = await calculateLeverage(symbol, credentials.binance.apiKey, credentials.binance.apiSecret);
  const requestedLev = settings.leverage ?? 1;
  const lev = Math.min(requestedLev, maxAllowedLev);
  console.log(`${P} Requested Lev: ${requestedLev}, Max Allowed: ${maxAllowedLev}, Using: ${lev}`);

  let targetTotalQty = 0;
  const manQty = Number(settings.manualQuantity) || 0;
  const minBal = Math.min(binanceBalance, bybitBalance);

  if (manQty > 0) {
    targetTotalQty = parseFloat(formatQuantity(manQty, Math.max(bybitStepSize, binanceStepSize)));
    const requiredNotional = targetTotalQty * priceBybitBase;
    const requiredMargin = requiredNotional / lev;

    console.log(`${P} Manual Trade Override: Target Qty=${targetTotalQty}, Required Margin=$${requiredMargin.toFixed(2)} (Avail=$${minBal.toFixed(2)}, Lev: ${lev})`);

    if (requiredMargin > minBal) {
      console.log(`${P} Insufficient absolute balance for manual quantity. Capping to max available.`);
      const maxPossibleNotional = minBal * lev;
      const maxPossibleQtyRaw = maxPossibleNotional / priceBybitBase;
      targetTotalQty = parseFloat(formatQuantity(maxPossibleQtyRaw, Math.max(bybitStepSize, binanceStepSize)));
      console.log(`${P} Adjusted Manual Target Total Qty=${targetTotalQty}`);
    }
  } else {
    if (settings.fixedCapitalPerTrade && settings.fixedCapitalPerTrade > 0) {
      const actualCapital = Math.min(minBal, settings.fixedCapitalPerTrade);
      const targetNotional = actualCapital * lev;
      const targetQtyRaw = targetNotional / priceBybitBase;
      targetTotalQty = parseFloat(formatQuantity(targetQtyRaw, Math.max(bybitStepSize, binanceStepSize)));
      console.log(`${P} Auto Target Notional=$${targetNotional.toFixed(2)}, Target Total Qty=${targetTotalQty} (Fixed Capital: $${actualCapital.toFixed(2)}, Lev: ${lev})`);
    } else {
      const capPct = Math.max(0, Math.min(100, settings.capitalPercent ?? 10)) / 100;
      const targetNotional = minBal * capPct * lev;
      const targetQtyRaw = targetNotional / priceBybitBase;
      targetTotalQty = parseFloat(formatQuantity(targetQtyRaw, Math.max(bybitStepSize, binanceStepSize)));
      console.log(`${P} Auto Target Notional=$${targetNotional.toFixed(2)}, Target Total Qty=${targetTotalQty} (Cap%: ${capPct * 100}%, Lev: ${lev})`);
    }
  }

  if (targetTotalQty <= 0) {
    console.log(`${P} Abort: target total qty is 0`);
    onProgress?.("Trade failed: Target quantity is 0");
    results.push({ success: false, error: "Target quantity is 0" });
    return results;
  }

  let cumulativeFilled = 0;

  let firstChunkQtyRaw = minNotional / priceBybitBase;
  if (!isExit && firstChunkQtyRaw > targetTotalQty) firstChunkQtyRaw = targetTotalQty;
  const firstChunkQtyBybitStr = formatQuantity(firstChunkQtyRaw, bybitStepSize);
  const firstChunkQty = parseFloat(firstChunkQtyBybitStr) || 0;
  if (firstChunkQty <= 0) {
    console.log(`${P} Abort: first chunk qty rounded to 0 (raw=${firstChunkQtyRaw})`);
    onProgress?.("Trade failed: First chunk quantity too small");
    results.push({ success: false, error: "First chunk quantity too small after step size" });
    return results;
  }
  console.log(`${P} First chunk: minNotional=$${minNotional} priceBybit=${priceBybitBase} -> qty(raw)=${firstChunkQtyRaw} qty(formatted)=${firstChunkQtyBybitStr}`);

  let bybitOrderId: string | null = null;
  let filledBybit = 0;

  try {
    try {
      console.log(`${P} Sending Chunk 1 to Bybit: qty=${firstChunkQtyBybitStr} price=${execPriceBybit}`);
      let bybitRes: { orderId: string; orderStatus: string };
      try {
        bybitRes = await placeBybitOrder(
          credentials.bybit.apiKey,
          credentials.bybit.apiSecret,
          {
            symbol,
            side: bybitSide,
            orderType: "Limit",
            timeInForce: "IOC",
            qty: firstChunkQtyBybitStr,
            price: execPriceBybit,
            category: "linear",
            reduceOnly,
          }
        );
      } catch (orderErr) {
        if (isExit) {
          const msg = orderErr instanceof Error ? orderErr.message : String(orderErr);
          console.log(`${P} Bybit exit failed (order rejected): ${msg}. Forcing Binance Orphan Exit.`);
          onProgress?.("Bybit failed, forcing Binance orphan exit…");
          filledBybit = 0;
          bybitOrderId = null;
          throw orderErr;
        }
        throw orderErr;
      }
      bybitOrderId = bybitRes.orderId;
      if (!bybitOrderId || bybitRes.orderStatus === "Rejected") {
        if (isExit) {
          console.log(`${P} Bybit exit failed/0 fill. Forcing Binance Orphan Exit.`);
          onProgress?.("Bybit skipped, forcing Binance orphan exit…");
          filledBybit = 0;
        } else {
          console.log(`${P} Bybit Chunk 1 rejected: orderId=${bybitRes.orderId} status=${bybitRes.orderStatus}`);
          onProgress?.("Trade failed: Bybit first chunk rejected");
          results.push({ success: false, error: "Bybit first chunk rejected", bybitOrder: { exchange: "bybit", orderId: bybitRes.orderId, symbol, side, quantity: firstChunkQty, price: priceBybitBase, status: "REJECTED" } });
          return results;
        }
      } else {
        console.log(`${P} Chunk 1 Bybit order placed: orderId=${bybitOrderId}. Waiting for confirmation...`);
        onProgress?.("Chunk 1 placed");

        await sleep(delayMs);
        if (isExit) {
          try {
            filledBybit = await privateWs.waitForOrderConfirmation("bybit", bybitOrderId, CONFIRM_TIMEOUT_MS);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`${P} Bybit exit failed (confirmation error): ${msg}. Forcing Binance Orphan Exit.`);
            onProgress?.("Bybit failed, forcing Binance orphan exit…");
            filledBybit = 0;
          }
        } else {
          filledBybit = await privateWs.waitForOrderConfirmation("bybit", bybitOrderId, CONFIRM_TIMEOUT_MS);
        }
        console.log(`${P} Confirmation from Bybit: filledQty=${filledBybit}`);

        if (filledBybit === 0) {
          if (isExit) {
            console.log(`${P} Bybit exit failed/0 fill. Forcing Binance Orphan Exit.`);
            onProgress?.("Bybit filled 0, forcing Binance orphan exit…");
          } else {
            console.log(`${P} Bybit IOC filled 0. Aborting this chunk to prevent unhedged exposure.`);
            onProgress?.("Trade failed: Bybit IOC filled 0");
            results.push({
              success: false,
              error: "Bybit IOC filled 0",
              bybitOrder: { exchange: "bybit", orderId: bybitOrderId!, symbol, side, quantity: firstChunkQty, price: priceBybitBase, status: "FILLED" },
            });
            return results;
          }
        }
      }
    } catch (bybitErr) {
      if (!isExit) throw bybitErr;
      const errMsg = bybitErr instanceof Error ? bybitErr.message : String(bybitErr);
      console.log(`${P} Bybit exit failed/rejected: ${errMsg}. Bypassing to Binance for Orphan Exit.`);
      onProgress?.("Bybit failed, bypassing to Binance orphan exit…");
      filledBybit = 0;
    }

    const formattedQty = parseFloat(formatQuantity(firstChunkQty, binanceStepSize)) || firstChunkQty;
    const binanceTargetQty = isExit ? formattedQty : (filledBybit > 0 ? filledBybit : firstChunkQty);

    if (binanceTargetQty > 0) {
      try {
        const binanceQtyStr = formatQuantity(binanceTargetQty, binanceStepSize);
        console.log(`${P} Sending Chunk 1 to Binance: qty=${binanceQtyStr} price=${execPriceBinance}`);
        const binanceRes = await placeBinanceOrder(
          credentials.binance.apiKey,
          credentials.binance.apiSecret,
          {
            symbol,
            side: binanceSide,
            type: "LIMIT",
            timeInForce: "IOC",
            quantity: binanceQtyStr,
            price: execPriceBinance,
            reduceOnly,
          }
        ).catch(async (err) => {
          if (!isExit) {
            console.log(`${P} Binance Chunk 1 failed: ${err}. Closing Bybit leg...`);
            const closeQtyStr = formatQuantity(filledBybit > 0 ? filledBybit : firstChunkQty, bybitStepSize);
            await placeBybitOrder(credentials.bybit.apiKey, credentials.bybit.apiSecret, {
              symbol,
              side: bybitSide === "Buy" ? "Sell" : "Buy",
              orderType: "Limit",
              timeInForce: "IOC",
              qty: closeQtyStr,
              price: execPriceBybit,
              category: "linear",
              reduceOnly,
            }).catch(() => {});
            throw err;
          }
          throw err;
        });

        console.log(`${P} Waiting for Binance Chunk 1 confirmation...`);
        await privateWs.waitForOrderConfirmation("binance", binanceRes.orderId, CONFIRM_TIMEOUT_MS, symbol);
        cumulativeFilled += filledBybit;

        console.log(`${P} Chunk 1 complete. Bybit orderId=${bybitOrderId} Binance orderId=${binanceRes.orderId}`);
        onProgress?.("Chunk 1 complete");
        results.push({
          success: true,
          bybitOrder: { exchange: "bybit", orderId: bybitOrderId!, symbol, side, quantity: firstChunkQty, price: priceBybitBase, filledQty: filledBybit, status: "FILLED" },
          binanceOrder: { exchange: "binance", orderId: binanceRes.orderId, symbol, side, quantity: firstChunkQty, price: priceBinanceBase, status: binanceRes.status as PlacedOrder["status"] },
        });
      } catch (binanceErr) {
        if (isExit) {
          const errMsg = binanceErr instanceof Error ? binanceErr.message : String(binanceErr);
          console.log(`${P} [CHUNK-SYSTEM] Binance exit failed (chunk done for cleanup): ${errMsg}`);
          onProgress?.(`Binance exit failed: ${errMsg}`);
          results.push({ success: false, error: errMsg });
          return results;
        }
        throw binanceErr;
      }
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.log(`${P} Chunk 1 error/abort: ${errMsg} closedBybitAfterBinanceFail=${!!bybitOrderId}`);
    onProgress?.(`Trade failed: ${errMsg}`);
    results.push({
      success: false,
      error: errMsg,
      bybitOrder: bybitOrderId
        ? { exchange: "bybit", orderId: bybitOrderId, symbol, side, quantity: firstChunkQty, price: priceBybitBase, status: "FILLED" as const }
        : undefined,
      closedBybitAfterBinanceFail: !!bybitOrderId,
    });
    return results;
  }

  const firstRowQty = getFirstRowQty(orderbook, bybitOrderbookSide);
  console.log(`${P} Chunk 2+: firstRowQty=${firstRowQty} frac=${frac} (liquidity fraction for subsequent chunks)`);

  for (let i = 0; i < 10; i++) {
    const remaining = targetTotalQty - cumulativeFilled;
    if (!isExit && (remaining <= 0 || remaining < Math.min(bybitStepSize, binanceStepSize))) {
      console.log(`${P} Target quantity reached (${cumulativeFilled}/${targetTotalQty}). Stopping chunks.`);
      onProgress?.("Target quantity reached");
      break;
    }

    const priceBybitNext = getBestPrice(orderbook, bybitOrderbookSide);
    const priceBinanceNext = getBestPrice(orderbook, binanceOrderbookSide);
    if (priceBybitNext <= 0 || priceBinanceNext <= 0) {
      console.log(`${P} Chunk ${i + 2}: no price, stopping.`);
      break;
    }
    const slipPctNext = (settings.slippagePercent ?? 0.05) / 100;
    const execBybitNextRaw = isBybitBuy ? priceBybitNext * (1 + slipPctNext) : priceBybitNext * (1 - slipPctNext);
    const execBinanceNextRaw = isBinanceBuy ? priceBinanceNext * (1 + slipPctNext) : priceBinanceNext * (1 - slipPctNext);
    const execPriceBybitNext = formatPrice(execBybitNextRaw, bybitTickSize);
    const execPriceBinanceNext = formatPrice(execBinanceNextRaw, binanceTickSize);
    ensurePriceValid(execPriceBybitNext, execBybitNextRaw, "Bybit");
    ensurePriceValid(execPriceBinanceNext, execBinanceNextRaw, "Binance");

    let chunkQtyRaw = firstRowQty * frac;
    if (!isExit && chunkQtyRaw > remaining) chunkQtyRaw = remaining;

    const chunkQtyBybitStr = formatQuantity(chunkQtyRaw, bybitStepSize);
    const chunkQty = parseFloat(chunkQtyBybitStr) || 0;
    if (chunkQty <= 0) {
      console.log(`${P} Chunk ${i + 2}: chunk qty rounded to 0. Stopping.`);
      break;
    }

    let bybitId: string | null = null;
    try {
      console.log(`${P} Sending Chunk ${i + 2} to Bybit: qty=${chunkQtyBybitStr} price=${execPriceBybitNext}`);
      onProgress?.(`Chunk ${i + 2} placed`);
      const resBybit = await placeBybitOrder(
        credentials.bybit.apiKey,
        credentials.bybit.apiSecret,
        {
          symbol,
          side: bybitSide,
          orderType: "Limit",
          timeInForce: "IOC",
          qty: chunkQtyBybitStr,
          price: execPriceBybitNext,
          category: "linear",
          reduceOnly,
        }
      );
      bybitId = resBybit.orderId;
      if (!bybitId || resBybit.orderStatus === "Rejected") {
        console.log(`${P} Chunk ${i + 2} Bybit rejected. Aborting remaining chunks.`);
        onProgress?.("Trade failed: Bybit chunk rejected");
        results.push({ success: false, error: "Bybit chunk rejected", abortedBybit: true });
        break;
      }
      await sleep(delayMs);
      const filled = await privateWs.waitForOrderConfirmation("bybit", bybitId, CONFIRM_TIMEOUT_MS);
      console.log(`${P} Chunk ${i + 2} Bybit confirmed: filledQty=${filled}. Sending to Binance...`);
      if (filled === 0) {
        console.log(`${P} Bybit IOC filled 0. Aborting this chunk to prevent unhedged exposure.`);
        onProgress?.("Trade failed: Bybit IOC filled 0");
        results.push({ success: false, error: "Bybit IOC filled 0", abortedBybit: true });
        break;
      }
      cumulativeFilled += filled;

      const binanceChunkQtyStr = formatQuantity(filled, binanceStepSize);
      const binanceRes = await placeBinanceOrder(credentials.binance.apiKey, credentials.binance.apiSecret, {
        symbol,
        side: binanceSide,
        type: "LIMIT",
        timeInForce: "IOC",
        quantity: binanceChunkQtyStr,
        price: execPriceBinanceNext,
        reduceOnly,
      });

      console.log(`${P} Waiting for Binance Chunk ${i + 2} confirmation...`);
      await privateWs.waitForOrderConfirmation("binance", binanceRes.orderId ?? "", CONFIRM_TIMEOUT_MS, symbol);

      console.log(`${P} Chunk ${i + 2} complete.`);
      onProgress?.(`Chunk ${i + 2} complete`);
      results.push({
        success: true,
        bybitOrder: { exchange: "bybit", orderId: bybitId, symbol, side, quantity: chunkQty, price: priceBybitNext, filledQty: filled, status: "FILLED" },
        binanceOrder: { exchange: "binance", orderId: binanceRes.orderId ?? "", symbol, side, quantity: chunkQty, price: priceBinanceNext, status: "FILLED" },
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`${P} Chunk ${i + 2} error: ${errMsg}. Abort reason: ${bybitId ? "Binance failed, closed Bybit leg" : "Bybit failed"}.`);
      onProgress?.(`Trade failed: ${errMsg}`);
      results.push({
        success: false,
        error: errMsg,
        closedBybitAfterBinanceFail: !!bybitId,
      });
      break;
    }
  }

  console.log(`${P} Final completion: ${results.length} chunk(s) executed.`);
  if (results.length > 0 && results[results.length - 1]?.success) {
    onProgress?.("Trade completed");
  }
  return results;
}

// ---------------------------------------------------------------------------
// Resilient Close: exact position size, dynamic slippage & precision, retry loop (max 15), ignore ReduceOnly reject
// ---------------------------------------------------------------------------

function normalizeSymbolForMatch(s: string): string {
  return (s || "").toUpperCase();
}

export async function executeCloseTrade(
  symbol: string,
  credentials: ExchangeCredentials,
  privateWs: PrivateWSManager,
  fetchOrderbook: (symbol: string) => Promise<OrderbookSnapshot>,
  onProgress?: (msg: string) => void,
  userEmail?: string,
  exitReason?: string
): Promise<boolean> {
  const P = "[CHUNK-SYSTEM]";
  const executionLogs: string[] = [];
  const log = (msg: string) => {
    console.log(P + " " + msg);
    executionLogs.push(msg);
  };
  const symNorm = normalizeSymbolForMatch(symbol);

  // Step A: Exact position size from APIs
  const [binanceList, bybitList] = await Promise.all([
    getBinancePositions(credentials.binance.apiKey, credentials.binance.apiSecret),
    getBybitPositions(credentials.bybit.apiKey, credentials.bybit.apiSecret),
  ]);
  const bPos = binanceList.find((p) => normalizeSymbolForMatch(p.symbol) === symNorm && p.quantity > 0);
  const yPos = bybitList.find((p) => normalizeSymbolForMatch(p.symbol) === symNorm && p.quantity > 0);

  let binanceOpen = bPos?.quantity ?? 0;
  let bybitOpen = yPos?.quantity ?? 0;

  const binanceEntryPrice = bPos?.entryPrice ?? 0;
  const bybitEntryPrice = yPos?.entryPrice ?? 0;
  const totalMarginUsed = (bPos?.marginUsed ?? 0) + (yPos?.marginUsed ?? 0);
  const startQty = Math.max(binanceOpen, bybitOpen);
  const startTime = Date.now();

  const bSide = bPos?.side ?? "Long";
  const ySide = yPos?.side ?? "Long";

  const binanceCloseSide = bSide === "Long" ? "SELL" : "BUY";
  const bybitCloseSide = ySide === "Long" ? "Sell" : "Buy";

  const isBuyBinance = binanceCloseSide === "BUY";
  const isBuyBybit = bybitCloseSide === "Buy";

  if (binanceOpen <= 0 && bybitOpen <= 0) {
    log("No open position to close");
    onProgress?.("No open position to close");
    return true;
  }

  const [bybitStepSize, binanceStepSize, bybitTickSize, binanceTickSize] = await Promise.all([
    getBybitStepSize(symbol),
    getBinanceStepSize(symbol),
    getBybitTickSize(symbol),
    getBinanceTickSize(symbol),
  ]);

  let attempts = 0;
  const maxAttempts = 15;

  while ((binanceOpen > 0 || bybitOpen > 0) && attempts < maxAttempts) {
    attempts++;
    const progressMsg = `Close attempt ${attempts}/${maxAttempts} (Bybit: ${bybitOpen} Binance: ${binanceOpen})`;
    log(progressMsg);
    onProgress?.(progressMsg);

    // Fetch both orderbooks separately
    const [orderbookBinance, orderbookBybit] = await Promise.all([
      fetchOrderbook(symbol),
      getBybitOrderbookFast(symbol),
    ]);
    const binanceBestAsk = orderbookBinance.asks[0]?.[0] ? parseFloat(orderbookBinance.asks[0][0]) : 0;
    const binanceBestBid = orderbookBinance.bids[0]?.[0] ? parseFloat(orderbookBinance.bids[0][0]) : 0;

    if (binanceBestAsk <= 0 || binanceBestBid <= 0 || orderbookBybit.bestAsk <= 0 || orderbookBybit.bestBid <= 0) {
      log("No orderbook price, retrying…");
      onProgress?.("No orderbook price, retrying…");
      await sleep(500);
      continue;
    }
    const slipPct = ((credentials as { slippagePercent?: number }).slippagePercent ?? 0.05) / 100 + 0.001 * (attempts - 1);
    const slipBuy = 1 + slipPct;
    const slipSell = 1 - slipPct;
    const rawPriceBybit = isBuyBybit ? orderbookBybit.bestAsk * slipBuy : orderbookBybit.bestBid * slipSell;
    const rawPriceBinance = isBuyBinance ? binanceBestAsk * slipBuy : binanceBestBid * slipSell;
    const priceBybitStr = formatPrice(rawPriceBybit, bybitTickSize);
    const priceBinanceStr = formatPrice(rawPriceBinance, binanceTickSize);
    ensurePriceValid(priceBybitStr, rawPriceBybit, "Bybit close");
    ensurePriceValid(priceBinanceStr, rawPriceBinance, "Binance close");

    // Step D: Bybit leg
    if (bybitOpen > 0) {
      const bybitQtyStr = formatQuantity(bybitOpen, bybitStepSize);
      const qtyNum = parseFloat(bybitQtyStr) || 0;
      if (qtyNum > 0) {
        try {
          const bybitRes = await placeBybitOrder(
            credentials.bybit.apiKey,
            credentials.bybit.apiSecret,
            {
              symbol,
              side: bybitCloseSide,
              orderType: "Limit",
              timeInForce: "IOC",
              qty: bybitQtyStr,
              price: priceBybitStr,
              category: "linear",
              reduceOnly: true,
            }
          );
          if (bybitRes.orderId && bybitRes.orderStatus !== "Rejected") {
            await sleep(DEFAULT_DELAY_MS);
            const filled = await privateWs.waitForOrderConfirmation("bybit", bybitRes.orderId, CONFIRM_TIMEOUT_MS);
            bybitOpen = Math.max(0, bybitOpen - filled);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.toLowerCase().includes("reduceonly")) {
            log(`Bybit close error: ${msg}`);
          }
          // Treat as 0 fill (don't subtract)
        }
      }
    }

    // Step D: Binance leg
    if (binanceOpen > 0) {
      const binanceQtyStr = formatQuantity(binanceOpen, binanceStepSize);
      const qtyNum = parseFloat(binanceQtyStr) || 0;
      if (qtyNum > 0) {
        try {
          const binanceRes = await placeBinanceOrder(
            credentials.binance.apiKey,
            credentials.binance.apiSecret,
            {
              symbol,
              side: binanceCloseSide,
              type: "LIMIT",
              timeInForce: "IOC",
              quantity: binanceQtyStr,
              price: priceBinanceStr,
              reduceOnly: true,
            }
          );
          await sleep(DEFAULT_DELAY_MS);
          const filled = await privateWs.waitForOrderConfirmation(
            "binance",
            binanceRes.orderId ?? "",
            CONFIRM_TIMEOUT_MS,
            symbol
          );
          binanceOpen = Math.max(0, binanceOpen - filled);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.toLowerCase().includes("reduceonly")) {
            log(`Binance close error: ${msg}`);
          }
        }
      }
    }

    // Step E: Pause before next iteration if still not fully closed
    if (binanceOpen > 0 || bybitOpen > 0) {
      await sleep(500);
    }
  }

  const fullyClosed = binanceOpen <= 0 && bybitOpen <= 0;
  if (fullyClosed) {
    log("Position fully closed.");
    onProgress?.("Position fully closed.");
    logClosedTrade(symbol, credentials, startTime, startQty, binanceEntryPrice, bybitEntryPrice, totalMarginUsed, userEmail, exitReason ?? "Unknown", executionLogs).catch(() => {});
  } else {
    const incompleteMsg = `Exit incomplete after ${maxAttempts} attempts (Bybit: ${bybitOpen} Binance: ${binanceOpen}).`;
    log(incompleteMsg);
    onProgress?.(incompleteMsg);
  }
  return fullyClosed;
}

// ---------------------------------------------------------------------------
// Real-Execution Trade Logger: fetch exact exchange data after close, append to trade-logs.json
// ---------------------------------------------------------------------------

async function logClosedTrade(
  symbol: string,
  credentials: ExchangeCredentials,
  startTime: number,
  qty: number,
  binanceEntry: number,
  bybitEntry: number,
  totalMarginUsed: number,
  userEmail?: string,
  exitReason: string = "Unknown",
  executionLogs: string[] = []
): Promise<void> {
  try {
    await sleep(3000); // Allow exchange databases to index the fill
    const timestamp = Date.now();

    // Bybit Real Data (closed-pnl)
    const bybitQs = `category=linear&symbol=${symbol}&limit=10`;
    const bybitSign = signBybitV5Get(credentials.bybit.apiSecret, String(timestamp), credentials.bybit.apiKey, "5000", bybitQs);
    const bybitRes = await fetch(`${BYBIT_BASE}/v5/position/closed-pnl?${bybitQs}`, {
      headers: {
        "X-BAPI-API-KEY": credentials.bybit.apiKey,
        "X-BAPI-SIGN": bybitSign,
        "X-BAPI-TIMESTAMP": String(timestamp),
        "X-BAPI-RECV-WINDOW": "5000",
      },
    });
    const bybitData = await bybitRes.json();
    const bybitList = (bybitData?.result?.list ?? []) as { updatedTime?: number; closedPnl?: string; avgExitPrice?: string }[];
    const recentBybit = bybitList.filter((x) => Number(x.updatedTime) >= startTime - 5000);
    let bybitPnl = 0;
    let bybitExit = 0;
    if (recentBybit.length > 0) {
      for (const r of recentBybit) bybitPnl += Number(r.closedPnl ?? 0);
      bybitExit = Number(recentBybit[0].avgExitPrice ?? 0);
    }

    // Binance Real Data (income + userTrades for exit price)
    const bIncQs = `symbol=${symbol}&incomeType=REALIZED_PNL&limit=20&timestamp=${timestamp}`;
    const bIncSign = signBinance(credentials.binance.apiSecret, bIncQs);
    const bIncRes = await fetch(`${BINANCE_BASE}/fapi/v1/income?${bIncQs}&signature=${bIncSign}`, {
      headers: { "X-MBX-APIKEY": credentials.binance.apiKey },
    });
    let bIncJson: { time?: number; income?: string }[] = [];
    try {
      const arr = await bIncRes.json();
      bIncJson = Array.isArray(arr) ? arr : [];
    } catch {
      // ignore
    }
    const recentBInc = bIncJson.filter((x) => (x.time ?? 0) >= startTime - 5000);
    let binancePnl = 0;
    for (const r of recentBInc) binancePnl += Number(r.income ?? 0);

    const bTrdQs = `symbol=${symbol}&limit=20&timestamp=${timestamp}`;
    const bTrdSign = signBinance(credentials.binance.apiSecret, bTrdQs);
    const bTrdRes = await fetch(`${BINANCE_BASE}/fapi/v1/userTrades?${bTrdQs}&signature=${bTrdSign}`, {
      headers: { "X-MBX-APIKEY": credentials.binance.apiKey },
    });
    let bTrdJson: { time?: number; price?: string; qty?: string }[] = [];
    try {
      const arr = await bTrdRes.json();
      bTrdJson = Array.isArray(arr) ? arr : [];
    } catch {
      // ignore
    }
    const recentBTrd = bTrdJson.filter((x) => (x.time ?? 0) >= startTime - 5000);
    let bExitNotional = 0;
    let bExitQty = 0;
    for (const r of recentBTrd) {
      bExitNotional += Number(r.price ?? 0) * Number(r.qty ?? 0);
      bExitQty += Number(r.qty ?? 0);
    }
    const binanceExit = bExitQty > 0 ? bExitNotional / bExitQty : 0;

    const combinedPnlUsd = bybitPnl + binancePnl;
    const combinedPnlPct = totalMarginUsed > 0 ? (combinedPnlUsd / totalMarginUsed) * 100 : 0;

    const logEntry = {
      id: crypto.randomUUID(),
      symbol,
      qty,
      timestamp,
      binanceEntry,
      binanceExit,
      binancePnl,
      bybitEntry,
      bybitExit,
      bybitPnl,
      combinedPnlUsd,
      combinedPnlPct,
      exitReason,
      executionLogs,
      ...(userEmail != null && userEmail !== "" && { userEmail }),
    };
    const logPath = path.join(process.cwd(), "trade-logs.json");
    let logs: unknown[] = [];
    try {
      if (fs.existsSync(logPath)) logs = JSON.parse(fs.readFileSync(logPath, "utf-8")) as unknown[];
    } catch {
      // ignore
    }
    if (!Array.isArray(logs)) logs = [];
    logs.unshift(logEntry);
    if (logs.length > 200) logs = logs.slice(0, 200);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), "utf-8");
    console.log(`[LOGGER] Real Exit Logged for ${symbol}: PnL $${combinedPnlUsd.toFixed(2)} (${combinedPnlPct.toFixed(2)}%)`);
  } catch (e) {
    console.error("[LOGGER] Failed:", e);
  }
}
