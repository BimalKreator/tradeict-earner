const mockOpportunities = [
  { pair: "BTCUSDT", binancePrice: 67234.5, bybitPrice: 67289.2, spread: 54.7, spreadPct: 0.081, fundingBinance: 0.01, fundingBybit: -0.02, fundingDiff: 0.03 },
  { pair: "ETHUSDT", binancePrice: 3456.1, bybitPrice: 3452.8, spread: -3.3, spreadPct: -0.096, fundingBinance: -0.005, fundingBybit: 0.01, fundingDiff: -0.015 },
  { pair: "SOLUSDT", binancePrice: 178.92, bybitPrice: 179.12, spread: 0.2, spreadPct: 0.112, fundingBinance: 0.02, fundingBybit: -0.01, fundingDiff: 0.03 },
  { pair: "BNBUSDT", binancePrice: 582.4, bybitPrice: 582.9, spread: 0.5, spreadPct: 0.086, fundingBinance: 0.008, fundingBybit: -0.012, fundingDiff: 0.02 },
  { pair: "XRPUSDT", binancePrice: 2.341, bybitPrice: 2.339, spread: -0.002, spreadPct: -0.085, fundingBinance: -0.01, fundingBybit: 0.015, fundingDiff: -0.025 },
  { pair: "DOGEUSDT", binancePrice: 0.3821, bybitPrice: 0.3824, spread: 0.0003, spreadPct: 0.079, fundingBinance: 0.015, fundingBybit: -0.02, fundingDiff: 0.035 },
];

function formatFunding(n: number) {
  const pct = (n * 100).toFixed(3);
  return `${Number(pct) >= 0 ? "+" : ""}${pct}%`;
}

export default function ScreenerPage() {
  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Screener</h1>
        <p className="text-slate-400 text-sm mt-1">Price spread and funding difference between Binance and Bybit</p>
      </div>

      <div className="glass-panel overflow-hidden">
        <div className="p-4 md:p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Market opportunities</h2>
          <p className="text-slate-400 text-sm mt-0.5">Mock data — spread and funding diff</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
                <th className="p-4">Pair</th>
                <th className="p-4">Binance</th>
                <th className="p-4">Bybit</th>
                <th className="p-4">Spread</th>
                <th className="p-4">Spread %</th>
                <th className="p-4">Funding (Binance)</th>
                <th className="p-4">Funding (Bybit)</th>
                <th className="p-4">Funding diff</th>
              </tr>
            </thead>
            <tbody>
              {mockOpportunities.map((row) => (
                <tr key={row.pair} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                  <td className="p-4 font-medium text-white">{row.pair}</td>
                  <td className="p-4 text-slate-300">${row.binancePrice.toLocaleString()}</td>
                  <td className="p-4 text-slate-300">${row.bybitPrice.toLocaleString()}</td>
                  <td className="p-4 text-slate-300">
                    {row.spread >= 0 ? "+" : ""}{typeof row.spread === "number" && row.spread < 1 && row.spread > -1 ? row.spread.toFixed(4) : row.spread.toFixed(2)}
                  </td>
                  <td className="p-4">
                    <span className={row.spreadPct >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {row.spreadPct >= 0 ? "+" : ""}{row.spreadPct.toFixed(3)}%
                    </span>
                  </td>
                  <td className="p-4 text-slate-300">{formatFunding(row.fundingBinance)}</td>
                  <td className="p-4 text-slate-300">{formatFunding(row.fundingBybit)}</td>
                  <td className="p-4">
                    <span className={row.fundingDiff >= 0 ? "text-emerald-400" : "text-amber-400"}>
                      {formatFunding(row.fundingDiff)}
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
