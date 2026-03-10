const mockActiveTrades = [
  { id: "1", pair: "BTCUSDT", side: "Long", exchange: "Binance", entry: 67234.5, mark: 67412.2, pnl: 127.4, pnlPct: 0.26 },
  { id: "2", pair: "ETHUSDT", side: "Short", exchange: "Bybit", entry: 3456.1, mark: 3448.9, pnl: 42.3, pnlPct: 0.21 },
  { id: "3", pair: "SOLUSDT", side: "Long", exchange: "Binance", entry: 178.92, mark: 179.45, pnl: 8.91, pnlPct: 0.30 },
];

const mockMetrics = [
  { label: "Total trades", value: "124", sub: "Last 30d" },
  { label: "Win rate", value: "68%", sub: "82 wins" },
  { label: "Avg. PnL/trade", value: "+$12.40", sub: "USDT" },
  { label: "Open positions", value: "3", sub: "Active" },
];

export default function DashboardPage() {
  const totalPnl = mockActiveTrades.reduce((s, t) => s + t.pnl, 0);
  const totalPnlFormatted = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Dashboard</h1>
      </div>

      {/* Total PnL hero */}
      <div className="glass-panel p-6 md:p-8">
        <p className="text-slate-400 text-sm font-medium uppercase tracking-wider mb-1">Total unrealized PnL</p>
        <p className={`text-3xl md:text-4xl font-bold ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {totalPnlFormatted}
        </p>
        <p className="text-slate-500 text-sm mt-2">Across all open positions</p>
      </div>

      {/* Account metrics grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {mockMetrics.map((m) => (
          <div key={m.label} className="glass-panel p-4 md:p-5">
            <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">{m.label}</p>
            <p className="text-xl md:text-2xl font-semibold text-white mt-1">{m.value}</p>
            <p className="text-slate-500 text-xs mt-0.5">{m.sub}</p>
          </div>
        ))}
      </div>

      {/* Active trades */}
      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Active trades</h2>
          <p className="text-slate-400 text-sm mt-0.5">Current open positions</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Pair</th>
                <th className="p-4">Side</th>
                <th className="p-4">Exchange</th>
                <th className="p-4">Entry</th>
                <th className="p-4">Mark</th>
                <th className="p-4 text-right">PnL</th>
              </tr>
            </thead>
            <tbody>
              {mockActiveTrades.map((t) => (
                <tr key={t.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="p-4 font-medium text-white">{t.pair}</td>
                  <td className="p-4">
                    <span className={t.side === "Long" ? "text-emerald-400" : "text-amber-400"}>{t.side}</span>
                  </td>
                  <td className="p-4 text-slate-300">{t.exchange}</td>
                  <td className="p-4 text-slate-300">${t.entry.toLocaleString()}</td>
                  <td className="p-4 text-slate-300">${t.mark.toLocaleString()}</td>
                  <td className="p-4 text-right">
                    <span className={t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} ({t.pnlPct}%)
                    </span>
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
