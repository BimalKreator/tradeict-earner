const mockLogs = [
  { id: "1", time: "2025-03-10 14:32", pair: "BTCUSDT", side: "Long", amount: 0.05, entry: 67100, exit: 67350, pnl: 12.5, status: "Closed" },
  { id: "2", time: "2025-03-10 12:18", pair: "ETHUSDT", side: "Short", amount: 1.2, entry: 3460, exit: 3452, pnl: 9.6, status: "Closed" },
  { id: "3", time: "2025-03-10 09:45", pair: "SOLUSDT", side: "Long", amount: 50, entry: 178.2, exit: 179.1, pnl: 45.0, status: "Closed" },
  { id: "4", time: "2025-03-09 16:22", pair: "BTCUSDT", side: "Short", amount: 0.02, entry: 66800, exit: 66920, pnl: -2.4, status: "Closed" },
  { id: "5", time: "2025-03-09 11:05", pair: "BNBUSDT", side: "Long", amount: 5, entry: 580, exit: 582.5, pnl: 12.5, status: "Closed" },
  { id: "6", time: "2025-03-08 18:40", pair: "ETHUSDT", side: "Long", amount: 0.5, entry: 3420, exit: 3440, pnl: 10.0, status: "Closed" },
];

export default function LogsPage() {
  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Logs</h1>
        <p className="text-slate-400 text-sm mt-1">History of completed trades (mock)</p>
      </div>

      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Completed trades</h2>
          <p className="text-slate-400 text-sm mt-0.5">Closed positions</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Time</th>
                <th className="p-4">Pair</th>
                <th className="p-4">Side</th>
                <th className="p-4">Amount</th>
                <th className="p-4">Entry</th>
                <th className="p-4">Exit</th>
                <th className="p-4 text-right">PnL</th>
                <th className="p-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {mockLogs.map((row) => (
                <tr key={row.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                  <td className="p-4 text-slate-300 text-sm">{row.time}</td>
                  <td className="p-4 font-medium text-white">{row.pair}</td>
                  <td className="p-4">
                    <span className={row.side === "Long" ? "text-emerald-400" : "text-amber-400"}>{row.side}</span>
                  </td>
                  <td className="p-4 text-slate-300">{row.amount}</td>
                  <td className="p-4 text-slate-300">${row.entry.toLocaleString()}</td>
                  <td className="p-4 text-slate-300">${row.exit.toLocaleString()}</td>
                  <td className="p-4 text-right">
                    <span className={row.pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className="text-slate-400 text-sm">{row.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
