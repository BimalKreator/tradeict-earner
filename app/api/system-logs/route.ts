import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import path from "path";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

interface LogEntry {
  timestamp: number;
  level: string;
  category: string;
  message: string;
}

function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as { timestamp?: number; level?: string; category?: string; message?: string };
    if (typeof obj.timestamp !== "number" || typeof obj.message !== "string") return null;
    return {
      timestamp: obj.timestamp,
      level: typeof obj.level === "string" ? obj.level : "INFO",
      category: typeof obj.category === "string" ? obj.category : "SYSTEM",
      message: obj.message,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!fs.existsSync(LOG_DIR)) return NextResponse.json([]);
    const cutoff = Date.now() - MAX_AGE_MS;
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));
    const all: LogEntry[] = [];
    for (const f of files) {
      const fp = path.join(LOG_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) continue;
        const content = fs.readFileSync(fp, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
          const entry = parseLogLine(line);
          if (entry && entry.timestamp >= cutoff) all.push(entry);
        }
      } catch {
        // skip unreadable files
      }
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    return NextResponse.json(all);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
