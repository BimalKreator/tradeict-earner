"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
      });
      if (res?.error) {
        setError("Invalid email or password");
        setLoading(false);
        return;
      }
      router.push(callbackUrl);
      router.refresh();
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 md:p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="glass-panel p-8 space-y-6">
          <div className="text-center">
            <h1 className="text-2xl md:text-3xl font-bold text-white">Tradeict Earner</h1>
            <p className="text-slate-400 text-sm mt-1">Sign in to continue</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full glass-button px-4 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="text-xs text-slate-500 text-center">
            Demo: admin@tradeict.com / demo123
          </p>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-slate-400">Loading…</p>
      </main>
    }>
      <LoginForm />
    </Suspense>
  );
}
