"use client";

import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 md:p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="glass-panel p-8 text-center space-y-4">
          <h1 className="text-2xl md:text-3xl font-bold text-white">Tradeict Earner</h1>
          <p className="text-slate-400 text-sm">
            You have been logged out. Sign in again to continue.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
            <Link
              href="/dashboard"
              className="glass-button px-5 py-3 rounded-xl text-sm font-medium text-white accent-border text-center"
            >
              Go to Dashboard
            </Link>
            <Link
              href="/"
              className="glass-button px-5 py-3 rounded-xl text-sm font-medium text-slate-200 border border-white/20 hover:bg-white/10 text-center"
            >
              Home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
