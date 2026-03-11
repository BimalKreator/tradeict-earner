"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const SETTINGS_STORAGE_KEY = "tradeict-earner-settings";

/** Sync auto-exit settings from localStorage to WS backend once on app load (any page). */
function useSyncAutoExitOnLoad() {
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || typeof window === "undefined") return;
    synced.current = true;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      let autoExit = false;
      let stoplossPercent = 2;
      let targetPercent = 1.5;
      if (raw) {
        const parsed = JSON.parse(raw) as { autoExit?: boolean; stoplossPercent?: number; targetPercent?: number };
        if (typeof parsed.autoExit === "boolean") autoExit = parsed.autoExit;
        if (typeof parsed.stoplossPercent === "number" && parsed.stoplossPercent >= 0) stoplossPercent = parsed.stoplossPercent;
        if (typeof parsed.targetPercent === "number" && parsed.targetPercent >= 0) targetPercent = parsed.targetPercent;
      }
      const wsUrl = `ws://${window.location.hostname}:8080`;
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            action: "set_auto_exit_settings",
            payload: { autoExit, stoplossPercent, targetPercent },
          })
        );
        setTimeout(() => ws.close(), 500);
      };
      ws.onerror = () => {};
    } catch {
      // ignore
    }
  }, []);
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/screener", label: "Screener", icon: ScreenerIcon },
  { href: "/funds", label: "Funds", icon: FundsIcon },
  { href: "/logs", label: "Logs", icon: LogsIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

function DashboardIcon({ active }: { active?: boolean }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM16 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM16 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  );
}
function ScreenerIcon({ active }: { active?: boolean }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
    </svg>
  );
}
function FundsIcon({ active }: { active?: boolean }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
function LogsIcon({ active }: { active?: boolean }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
}
function SettingsIcon({ active }: { active?: boolean }) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  isActive,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ active?: boolean }>;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
        isActive
          ? "bg-white/10 text-white border border-white/10 accent-border"
          : "text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent"
      }`}
    >
      <Icon active={isActive} />
      <span>{label}</span>
    </Link>
  );
}

function BottomNavLink({
  href,
  label,
  icon: Icon,
  isActive,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ active?: boolean }>;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex flex-col items-center gap-1 rounded-lg py-2 px-3 min-w-[64px] transition-all duration-200 ${
        isActive ? "text-blue-400" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      <Icon active={isActive} />
      <span className="text-xs font-medium">{label}</span>
    </Link>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useSyncAutoExitOnLoad();

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 md:w-56 md:border-r md:border-white/[0.06] md:bg-navy-900/80 md:backdrop-blur-glass z-30">
        <div className="p-4 border-b border-white/[0.06]">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-white tracking-tight">Tradeict Earner</span>
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-auto">
          {navItems.map(({ href, label, icon }) => (
            <NavLink
              key={href}
              href={href}
              label={label}
              icon={icon}
              isActive={pathname === href}
            />
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-h-screen md:pl-56 pb-20 md:pb-0">
        <div className="flex-1 p-4 md:p-6 lg:p-8">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around glass-panel-strong border-t border-white/[0.08] py-2 px-2 safe-area-bottom"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        {navItems.map(({ href, label, icon }) => (
          <BottomNavLink
            key={href}
            href={href}
            label={label}
            icon={icon}
            isActive={pathname === href}
          />
        ))}
      </nav>
    </div>
  );
}
