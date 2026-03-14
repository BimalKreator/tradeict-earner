"use client";

import { useCallback, useEffect, useState } from "react";

type LogCategory = "ENTRY" | "EXIT" | "MONITOR" | "SYSTEM";

interface LogEntry {
  timestamp: number;
  level: string;
  category: string;
  message: string;
}

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ENTRY", label: "Entry" },
  { value: "EXIT", label: "Exit" },
  { value: "MONITOR", label: "Monitor" },
  { value: "SYSTEM", label: "System" },
];

export default function TerminalLogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/system-logs");
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const id = setInterval(fetchLogs, 10000);
    return () => clearInterval(id);
  }, [fetchLogs]);

  const filtered = categoryFilter === "all"
    ? logs
    : logs.filter((e) => e.category === categoryFilter);

  const copyToClipboard = () => {
    const text = filtered
      .map(
        (e) =>
          `${new Date(e.timestamp).toISOString()} [${e.level}] [${e.category}] ${e.message}`
      )
      .join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const categoryColor = (cat: string) => {
    switch (cat) {
      case "ENTRY":
        return "text-emerald-400";
      case "EXIT":
        return "text-amber-400";
      case "MONITOR":
        return "text-blue-400";
      default:
        return "text-slate-400";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-slate-400">Category:</label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-white/[0.1] bg-white/[0.06] px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={copyToClipboard}
          className="glass-button px-4 py-2 rounded-xl text-sm font-medium text-slate-200"
        >
          Copy Logs
        </button>
      </div>

      <div className="glass-panel overflow-hidden rounded-xl">
        <pre className="bg-black/60 p-4 text-xs text-green-400 overflow-x-auto overflow-y-auto max-h-[70vh] rounded-lg font-mono whitespace-pre-wrap">
          {loading ? (
            <span className="text-slate-500">Loading terminal logs…</span>
          ) : filtered.length === 0 ? (
            <span className="text-slate-500">No logs in the last 48 hours.</span>
          ) : (
            filtered.map((e, i) => (
              <div key={`${e.timestamp}-${i}`} className="flex flex-wrap gap-2 py-0.5 border-b border-white/[0.04] last:border-0">
                <span className="text-slate-500 shrink-0">
                  {new Date(e.timestamp).toISOString()}
                </span>
                <span className={e.level === "ERROR" ? "text-red-400" : "text-slate-400"}>
                  [{e.level}]
                </span>
                <span className={categoryColor(e.category)}>[{e.category}]</span>
                <span className="text-slate-300 break-all">{e.message}</span>
              </div>
            ))
          )}
        </pre>
      </div>
    </div>
  );
}
