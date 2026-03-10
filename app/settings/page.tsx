"use client";

import { useEffect, useState } from "react";

const SETTINGS_STORAGE_KEY = "tradeict-earner-settings";

export interface SettingsState {
  autoTrade: boolean;
  autoExit: boolean;
  capitalPercent: number;
  maxTradeSlot: number;
  leverage: number;
  stoplossPercent: number;
  targetPercent: number;
}

const DEFAULT_SETTINGS: SettingsState = {
  autoTrade: false,
  autoExit: false,
  capitalPercent: 10,
  maxTradeSlot: 5,
  leverage: 3,
  stoplossPercent: 2,
  targetPercent: 1.5,
};

function loadSettings(): SettingsState {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return {
      autoTrade: typeof parsed.autoTrade === "boolean" ? parsed.autoTrade : DEFAULT_SETTINGS.autoTrade,
      autoExit: typeof parsed.autoExit === "boolean" ? parsed.autoExit : DEFAULT_SETTINGS.autoExit,
      capitalPercent: typeof parsed.capitalPercent === "number" ? parsed.capitalPercent : DEFAULT_SETTINGS.capitalPercent,
      maxTradeSlot: typeof parsed.maxTradeSlot === "number" ? parsed.maxTradeSlot : DEFAULT_SETTINGS.maxTradeSlot,
      leverage: typeof parsed.leverage === "number" ? parsed.leverage : DEFAULT_SETTINGS.leverage,
      stoplossPercent: typeof parsed.stoplossPercent === "number" ? parsed.stoplossPercent : DEFAULT_SETTINGS.stoplossPercent,
      targetPercent: typeof parsed.targetPercent === "number" ? parsed.targetPercent : DEFAULT_SETTINGS.targetPercent,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: SettingsState): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveSettings(settings);
  }, [settings, hydrated]);

  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const resetToDefaults = () => setSettings(DEFAULT_SETTINGS);

  const inputClass =
    "w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50";

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">Bot configuration — saved in this browser</p>
      </div>

      <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
        {/* Toggles */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Toggles</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            <div className="flex items-center justify-between rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3">
              <label className="text-sm font-medium text-slate-300">Auto Trade</label>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoTrade}
                onClick={() => update("autoTrade", !settings.autoTrade)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
                  settings.autoTrade
                    ? "border-blue-500/50 bg-blue-500/30"
                    : "border-white/[0.2] bg-white/[0.08]"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                    settings.autoTrade ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3">
              <label className="text-sm font-medium text-slate-300">Auto Exit</label>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoExit}
                onClick={() => update("autoExit", !settings.autoExit)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
                  settings.autoExit
                    ? "border-blue-500/50 bg-blue-500/30"
                    : "border-white/[0.2] bg-white/[0.08]"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                    settings.autoExit ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* Risk inputs */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Risk</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Capital % per trade</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={settings.capitalPercent}
                onChange={(e) => update("capitalPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Max trade slot</label>
              <input
                type="number"
                min={1}
                max={50}
                value={settings.maxTradeSlot}
                onChange={(e) => update("maxTradeSlot", Number(e.target.value) || 1)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Leverage</label>
              <input
                type="number"
                min={1}
                max={125}
                value={settings.leverage}
                onChange={(e) => update("leverage", Number(e.target.value) || 1)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Stoploss %</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={settings.stoplossPercent}
                onChange={(e) => update("stoplossPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Target %</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={settings.targetPercent}
                onChange={(e) => update("targetPercent", Number(e.target.value) || 0)}
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Exchange API keys */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Exchange API keys</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Binance API key</label>
              <input
                type="password"
                placeholder="••••••••••••••••"
                className={inputClass}
              />
              <input
                type="password"
                placeholder="Binance API secret"
                className={inputClass}
              />
            </div>
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Bybit API key</label>
              <input
                type="password"
                placeholder="••••••••••••••••"
                className={inputClass}
              />
              <input
                type="password"
                placeholder="Bybit API secret"
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Legacy risk (optional) */}
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Risk management</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Max position size (USDT)</label>
              <input type="number" placeholder="1000" min={0} className={inputClass} />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Min spread (%) to trade</label>
              <input type="number" placeholder="0.05" min={0} step={0.01} className={inputClass} />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Funding diff threshold (%)</label>
              <input type="number" placeholder="0.02" min={0} step={0.01} className={inputClass} />
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
            onClick={resetToDefaults}
            className="glass-button px-6 py-3 rounded-xl text-sm font-medium text-slate-400 border-white/[0.08]"
          >
            Reset to defaults
          </button>
        </div>
      </form>
    </div>
  );
}
