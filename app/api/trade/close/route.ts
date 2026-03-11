import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Trade exits are now handled exclusively via the WebSocket engine (EXECUTE_MANUAL_TRADE with isExit: true).' },
    { status: 410 }
  );
}
