export const dynamic = "force-dynamic";
export const revalidate = 0;

import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { authOptions } from "@/lib/auth";

const CONFIG_FILE = path.join(process.cwd(), "auto-exit-settings.json");

const DEFAULT_CONFIG = {
  autoTrade: false,
  autoExit: false,
  capitalPercent: 10,
  maxTradeSlot: 5,
  leverage: 3,
  stoplossPercent: 2,
  targetPercent: 1.5,
  slippagePercent: 0.05,
  feesPercent: 0.1,
  pnlCalculationMethod: "L2_VWAP" as "L2_VWAP" | "ORDERBOOK_DOUBLE_QTY",
};

export async function GET() {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as typeof DEFAULT_CONFIG;
    return NextResponse.json({
      autoTrade: typeof parsed.autoTrade === "boolean" ? parsed.autoTrade : DEFAULT_CONFIG.autoTrade,
      autoExit: typeof parsed.autoExit === "boolean" ? parsed.autoExit : DEFAULT_CONFIG.autoExit,
      capitalPercent: typeof parsed.capitalPercent === "number" ? parsed.capitalPercent : DEFAULT_CONFIG.capitalPercent,
      maxTradeSlot: typeof parsed.maxTradeSlot === "number" ? parsed.maxTradeSlot : DEFAULT_CONFIG.maxTradeSlot,
      leverage: typeof parsed.leverage === "number" ? parsed.leverage : DEFAULT_CONFIG.leverage,
      stoplossPercent: typeof parsed.stoplossPercent === "number" ? parsed.stoplossPercent : DEFAULT_CONFIG.stoplossPercent,
      targetPercent: typeof parsed.targetPercent === "number" ? parsed.targetPercent : DEFAULT_CONFIG.targetPercent,
      slippagePercent: typeof parsed.slippagePercent === "number" ? parsed.slippagePercent : DEFAULT_CONFIG.slippagePercent,
      feesPercent: typeof parsed.feesPercent === "number" ? parsed.feesPercent : DEFAULT_CONFIG.feesPercent,
      pnlCalculationMethod: parsed.pnlCalculationMethod === "ORDERBOOK_DOUBLE_QTY" ? "ORDERBOOK_DOUBLE_QTY" : "L2_VWAP",
    });
  } catch {
    return NextResponse.json(DEFAULT_CONFIG);
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Partial<typeof DEFAULT_CONFIG>;
    let existing: { autoTradeUserEmail?: string } = {};
    try {
      const raw = await readFile(CONFIG_FILE, "utf8");
      existing = JSON.parse(raw) as { autoTradeUserEmail?: string };
    } catch {
      // no existing file
    }
    // Merge incoming payload exactly; use defaults only for missing fields (no cached state).
    const config = {
      autoTrade: typeof body.autoTrade === "boolean" ? body.autoTrade : DEFAULT_CONFIG.autoTrade,
      autoExit: typeof body.autoExit === "boolean" ? body.autoExit : DEFAULT_CONFIG.autoExit,
      capitalPercent: typeof body.capitalPercent === "number" ? body.capitalPercent : DEFAULT_CONFIG.capitalPercent,
      maxTradeSlot: typeof body.maxTradeSlot === "number" ? body.maxTradeSlot : DEFAULT_CONFIG.maxTradeSlot,
      leverage: typeof body.leverage === "number" ? body.leverage : DEFAULT_CONFIG.leverage,
      stoplossPercent: typeof body.stoplossPercent === "number" ? body.stoplossPercent : DEFAULT_CONFIG.stoplossPercent,
      targetPercent: typeof body.targetPercent === "number" ? body.targetPercent : DEFAULT_CONFIG.targetPercent,
      slippagePercent: typeof body.slippagePercent === "number" ? body.slippagePercent : DEFAULT_CONFIG.slippagePercent,
      feesPercent: typeof body.feesPercent === "number" ? body.feesPercent : DEFAULT_CONFIG.feesPercent,
      pnlCalculationMethod: body.pnlCalculationMethod === "ORDERBOOK_DOUBLE_QTY" ? "ORDERBOOK_DOUBLE_QTY" : "L2_VWAP",
      autoTradeUserEmail: session.user.email ?? existing.autoTradeUserEmail,
    };
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    const { autoTradeUserEmail: _email, ...publicConfig } = config as typeof config & { autoTradeUserEmail?: string };
    return NextResponse.json(publicConfig);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
