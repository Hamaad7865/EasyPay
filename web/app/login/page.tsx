"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

// Sign-in only. Logins are created by the platform admin; there is no sign-up.
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const res = await authClient.signIn.email({ email, password });
    if (res.error) {
      setBusy(false);
      setError(res.error.message ?? "Sign-in failed");
      return;
    }
    // "/" sends a platform admin to /admin and everyone else to their back office
    router.push("/");
    router.refresh();
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="bo-brand-logo" />
          <span>Easy<span className="bo-brand-pos">Pay</span></span>
        </div>
        <h1>Sign in to your back office</h1>
        <p className="auth-lede">Your menu, your reports and your settings, wherever you are.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="auth-foot">No login yet? Restaurants are set up by EasyPay. Contact us.</p>
      </div>
    </main>
  );
}
