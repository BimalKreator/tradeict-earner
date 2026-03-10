"use client";

export default function SettingsPage() {
  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">Bot configuration (mock form — no backend)</p>
      </div>

      <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
        {/* Exchange API keys */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Exchange API keys</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Binance API key</label>
              <input
                type="password"
                placeholder="••••••••••••••••"
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
              <input
                type="password"
                placeholder="Binance API secret"
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Bybit API key</label>
              <input
                type="password"
                placeholder="••••••••••••••••"
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
              <input
                type="password"
                placeholder="Bybit API secret"
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
          </div>
        </div>

        {/* Risk management */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Risk management</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Max position size (USDT)</label>
              <input
                type="number"
                placeholder="1000"
                defaultValue="1000"
                min={0}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Stop loss (%)</label>
              <input
                type="number"
                placeholder="2"
                defaultValue="2"
                min={0}
                step={0.1}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Take profit (%)</label>
              <input
                type="number"
                placeholder="1.5"
                defaultValue="1.5"
                min={0}
                step={0.1}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Max open trades</label>
              <input
                type="number"
                placeholder="5"
                defaultValue="5"
                min={1}
                max={20}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Min spread (%) to trade</label>
              <input
                type="number"
                placeholder="0.05"
                defaultValue="0.05"
                min={0}
                step={0.01}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Funding diff threshold (%)</label>
              <input
                type="number"
                placeholder="0.02"
                defaultValue="0.02"
                min={0}
                step={0.01}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className="glass-button px-6 py-3 rounded-xl text-sm font-medium text-white accent-border"
          >
            Save settings
          </button>
          <button
            type="button"
            className="glass-button px-6 py-3 rounded-xl text-sm font-medium text-slate-400 border-white/[0.08]"
          >
            Reset to defaults
          </button>
        </div>
      </form>
    </div>
  );
}
