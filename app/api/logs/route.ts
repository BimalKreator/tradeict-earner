import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const logPath = path.join(process.cwd(), "trade-logs.json");
    if (!fs.existsSync(logPath)) return NextResponse.json([]);
    const data = fs.readFileSync(logPath, "utf-8");
    return NextResponse.json(JSON.parse(data));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
