import { NextResponse } from "next/server";

/**
 * Trade execution has been moved to the persistent WebSocket server.
 * Use the screener's manual trade flow (connected to ws://host:8080) which
 * sends EXECUTE_MANUAL_TRADE and receives TRADE_UPDATE progress.
 */
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Trade execution is only available via the WebSocket server. Connect to the WS server and use EXECUTE_MANUAL_TRADE." },
    { status: 410 }
  );
}
