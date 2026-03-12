"use client";

import { Suspense, useState } from "react";
import Image from "next/image";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

const inputClass =
  "w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";
  const [isRegistering, setIsRegistering] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
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

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          mobile: mobile.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Registration failed");
        setLoading(false);
        return;
      }
      const signInRes = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
      });
      if (signInRes?.error) {
        setSuccess("Account created. Please sign in.");
        setLoading(false);
        setIsRegistering(false);
        return;
      }
      router.push("/dashboard");
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
            <Image src="/icons/icon-192.png" alt="Tradeict Earner" width={192} height={192} className="mx-auto shrink-0 rounded-xl w-48 h-48 object-contain" />
            <p className="text-slate-400 text-sm mt-3">
              {isRegistering ? "Create your account" : "Sign in to continue"}
            </p>
          </div>
          {isRegistering ? (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label htmlFor="reg-name" className="block text-sm font-medium text-slate-300 mb-1">
                  Name
                </label>
                <input
                  id="reg-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                  placeholder="Your name"
                />
              </div>
              <div>
                <label htmlFor="reg-email" className="block text-sm font-medium text-slate-300 mb-1">
                  Email
                </label>
                <input
                  id="reg-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className={inputClass}
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label htmlFor="reg-mobile" className="block text-sm font-medium text-slate-300 mb-1">
                  Mobile (optional)
                </label>
                <input
                  id="reg-mobile"
                  name="mobile"
                  type="tel"
                  autoComplete="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  className={inputClass}
                  placeholder="+1 234 567 8900"
                />
              </div>
              <div>
                <label htmlFor="reg-password" className="block text-sm font-medium text-slate-300 mb-1">
                  Password
                </label>
                <input
                  id="reg-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className={inputClass}
                  placeholder="•••••••• (min 6 characters)"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              {success && <p className="text-sm text-emerald-400">{success}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full glass-button px-4 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              >
                {loading ? "Registering…" : "Register"}
              </button>
            </form>
          ) : (
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
                  className={inputClass}
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
                  className={inputClass}
                  placeholder="••••••••"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              {success && <p className="text-sm text-emerald-400">{success}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full glass-button px-4 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
          <div className="text-center pt-2 border-t border-white/[0.06]">
            <button
              type="button"
              onClick={() => {
                setIsRegistering(!isRegistering);
                setError("");
                setSuccess("");
              }}
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              {isRegistering
                ? "Already have an account? Sign in"
                : "Don't have an account? Register here"}
            </button>
          </div>
          {!isRegistering && (
            <p className="text-xs text-slate-500 text-center">
              Demo: admin@tradeict.com / demo123
            </p>
          )}
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
