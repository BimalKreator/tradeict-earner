"use client";

import { useEffect, useState } from "react";

export default function LogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLogs = async () => {
    try {
      const res = await fetch("/api/logs");
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const id = setInterval(fetchLogs, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold text-white">Trade History</h1>
      <p className="text-slate-400 text-sm mt-1">Real executed entry/exit prices and combined PnL from exchanges.</p>

      <div className="glass-panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Time</th>
                <th className="p-4">Symbol</th>
                <th className="p-4">Qty</th>
                <th className="p-4">Binance (En/Ex)</th>
                <th className="p-4">Bybit (En/Ex)</th>
                <th className="p-4 text-right">Combine PnL</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="p-8 text-center text-slate-500">Loading logs...</td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-slate-500">No closed trades yet.</td></tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id ?? log.timestamp} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                    <td className="p-4 text-sm text-slate-400">{log.timestamp != null ? new Date(log.timestamp).toLocaleTimeString() : "—"}</td>
                    <td className="p-4 text-sm font-medium text-white">{log.symbol ?? "—"}</td>
                    <td className="p-4 text-sm text-slate-300">{log.qty ?? "—"}</td>
                    <td className="p-4 text-sm">
                      <div className="text-slate-300">{Number(log.binanceEntry).toFixed(5)}</div>
                      <div className="text-slate-500">{Number(log.binanceExit).toFixed(5)}</div>
                      <div className={(log.binancePnl ?? 0) >= 0 ? "text-emerald-400 text-xs" : "text-red-400 text-xs"}>
                        {(log.binancePnl ?? 0) >= 0 ? "+" : ""}{Number(log.binancePnl).toFixed(2)}
                      </div>
                    </td>
                    <td className="p-4 text-sm">
                      <div className="text-slate-300">{Number(log.bybitEntry).toFixed(5)}</div>
                      <div className="text-slate-500">{Number(log.bybitExit).toFixed(5)}</div>
                      <div className={(log.bybitPnl ?? 0) >= 0 ? "text-emerald-400 text-xs" : "text-red-400 text-xs"}>
                        {(log.bybitPnl ?? 0) >= 0 ? "+" : ""}{Number(log.bybitPnl).toFixed(2)}
                      </div>
                    </td>
                    <td className="p-4 text-right">
                      <div className={`text-base font-bold ${(log.combinedPnlUsd ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${Number(log.combinedPnlUsd).toFixed(2)}
                      </div>
                      <div className={`text-xs mt-0.5 ${(log.combinedPnlPct ?? 0) >= 0 ? "text-emerald-400/80" : "text-red-400/80"}`}>
                        {Number(log.combinedPnlPct).toFixed(2)}%
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
