/**
 * Centralized file logger: intercepts console.log/error, writes JSON lines to
 * daily rotating logs/system-YYYY-MM-DD.log, and cleans files older than 48h.
 */

import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

export type LogLevel = "INFO" | "ERROR";
export type LogCategory = "ENTRY" | "EXIT" | "MONITOR" | "SYSTEM";

function getLogCategory(message: string): LogCategory {
  const m = String(message);
  if (/^\[AUTO-TRADE\]/.test(m)) return "ENTRY";
  if (/\[CHUNK-SYSTEM\]\s*Auto-Exit|Auto-Exit:/.test(m) || /Auto-Exit\s+/.test(m)) return "EXIT";
  if (/\[AUTO-EXIT|position|Position|orderbook|Orderbook|state\s|depth|VWAP\]/i.test(m)) return "MONITOR";
  return "SYSTEM";
}

function getLogFilePath(): string {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return path.join(LOG_DIR, `system-${y}-${m}-${d}.log`);
}

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function writeLogLine(level: LogLevel, message: string): void {
  try {
    ensureLogDir();
    const filePath = getLogFilePath();
    const category = getLogCategory(message);
    const line = JSON.stringify({
      timestamp: Date.now(),
      level,
      category,
      message: message.slice(0, 2000),
    }) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");
  } catch {
    // avoid breaking app if log write fails
  }
}

let originalLog: typeof console.log;
let originalError: typeof console.error;

export function initLogger(): void {
  if (typeof originalLog === "function") return; // already inited
  originalLog = console.log;
  originalError = console.error;

  console.log = (...args: unknown[]) => {
    const message = args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a))).join(" ");
    writeLogLine("INFO", message);
    originalLog.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    const message = args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a))).join(" ");
    writeLogLine("ERROR", message);
    originalError.apply(console, args);
  };
}

/** Delete log files older than 48 hours. */
export function cleanupOldLogs(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const fp = path.join(LOG_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > MAX_AGE_MS) fs.unlinkSync(fp);
    }
  } catch {
    // ignore
  }
}
