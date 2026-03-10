const mockBinance = [
  { asset: "USDT", balance: 12450.82, available: 11800.5, inOrders: 650.32 },
  { asset: "BTC", balance: 0.1842, available: 0.18, inOrders: 0.0042 },
  { asset: "ETH", balance: 2.45, available: 2.4, inOrders: 0.05 },
];

const mockBybit = [
  { asset: "USDT", balance: 8320.15, available: 8000.0, inOrders: 320.15 },
  { asset: "BTC", balance: 0.0921, available: 0.09, inOrders: 0.0021 },
  { asset: "ETH", balance: 1.2, available: 1.18, inOrders: 0.02 },
];

function ExchangeCard({
  name,
  totals,
  rows,
}: {
  name: string;
  totals: { totalUsdt: number; totalBtc: number };
  rows: { asset: string; balance: number; available: number; inOrders: number }[];
}) {
  return (
    <div className="glass-panel overflow-hidden">
      <div className="p-4 md:p-5 border-b border-white/[0.06] flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{name}</h2>
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Mock data</span>
      </div>
      <div className="p-4 md:p-5 grid grid-cols-2 gap-4 border-b border-white/[0.06]">
        <div>
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Total (USDT equiv)</p>
          <p className="text-xl font-semibold text-white mt-1">${totals.totalUsdt.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div>
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Total (BTC equiv)</p>
          <p className="text-xl font-semibold text-white mt-1">{totals.totalBtc.toFixed(4)} BTC</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px]">
          <thead>
            <tr className="text-left text-slate-400 text-xs font-medium uppercase tracking-wider border-b border-white/[0.06]">
              <th className="p-4">Asset</th>
              <th className="p-4 text-right">Balance</th>
              <th className="p-4 text-right">Available</th>
              <th className="p-4 text-right">In orders</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${name}-${r.asset}`} className="border-b border-white/[0.04] last:border-0">
                <td className="p-4 font-medium text-white">{r.asset}</td>
                <td className="p-4 text-right text-slate-300">{r.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td className="p-4 text-right text-slate-300">{r.available.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td className="p-4 text-right text-slate-400">{r.inOrders.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FundsPage() {
  const binanceTotalUsdt = mockBinance[0].balance + mockBinance[1].balance * 67200 + mockBinance[2].balance * 3450;
  const binanceTotalBtc = mockBinance[0].balance / 67200 + mockBinance[1].balance + mockBinance[2].balance * (3450 / 67200);
  const bybitTotalUsdt = mockBybit[0].balance + mockBybit[1].balance * 67200 + mockBybit[2].balance * 3450;
  const bybitTotalBtc = mockBybit[0].balance / 67200 + mockBybit[1].balance + mockBybit[2].balance * (3450 / 67200);

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Funds</h1>
        <p className="text-slate-400 text-sm mt-1">Exchange balances (mock)</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <ExchangeCard
          name="Binance"
          totals={{ totalUsdt: binanceTotalUsdt, totalBtc: binanceTotalBtc }}
          rows={mockBinance}
        />
        <ExchangeCard
          name="Bybit"
          totals={{ totalUsdt: bybitTotalUsdt, totalBtc: bybitTotalBtc }}
          rows={mockBybit}
        />
      </div>
    </div>
  );
}
