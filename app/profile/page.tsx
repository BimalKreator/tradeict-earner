"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";

export default function ProfilePage() {
  const { data: session, status } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const initialEmailRef = useRef<string>("");

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/profile");
      if (res.ok) {
        const data = await res.json();
        const n = data.name ?? "";
        const e = data.email ?? "";
        const m = data.mobile ?? "";
        setName(n);
        setEmail(e);
        setMobile(m);
        initialEmailRef.current = e;
      }
    } catch {
      setToast({ message: "Failed to load profile", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") fetchProfile();
    else if (status === "unauthenticated") setLoading(false);
  }, [status, fetchProfile]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          mobile: mobile.trim(),
          ...(password.trim() && { password: password.trim() }),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const emailChanged = email.trim().toLowerCase() !== initialEmailRef.current.toLowerCase();
        const passwordChanged = password.trim().length >= 6;
        if (emailChanged || passwordChanged) {
          setToast({
            message: "Profile updated. Please sign in with your new credentials.",
            type: "success",
          });
          setPassword("");
          setTimeout(() => {
            signOut({ callbackUrl: "/login" });
          }, 1500);
        } else {
          setToast({ message: "Profile updated", type: "success" });
          setPassword("");
          if (data.email != null) {
            setEmail(data.email);
            initialEmailRef.current = data.email;
          }
          if (data.name != null) setName(data.name);
          if (data.mobile !== undefined) setMobile(data.mobile);
        }
      } else {
        setToast({ message: data.error ?? "Update failed", type: "error" });
      }
    } catch {
      setToast({ message: "Update failed", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50";

  if (status === "loading" || loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Account settings</h1>
        <p className="text-slate-400">Loading…</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Account settings</h1>
        <p className="text-slate-400">Please sign in to view your profile.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 lg:space-y-8">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Account settings</h1>
        <p className="text-slate-400 text-sm mt-1">Update your name, email, mobile, and password</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Profile</h2>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder="Your name"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">Mobile number</label>
            <input
              type="tel"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              className={inputClass}
              placeholder="+1 234 567 8900"
            />
          </div>
        </div>

        <div className="glass-panel p-5 md:p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white border-b border-white/[0.06] pb-3">Login password</h2>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">New password (leave blank to keep current)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
              minLength={6}
              autoComplete="new-password"
            />
            <p className="text-xs text-slate-500">Minimum 6 characters</p>
          </div>
        </div>

        {toast && (
          <p className={`text-sm ${toast.type === "success" ? "text-emerald-400" : "text-red-400"}`}>{toast.message}</p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="glass-button px-5 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
