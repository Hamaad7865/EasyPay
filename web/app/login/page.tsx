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
    <main style={{ maxWidth: 400, margin: "80px auto", fontFamily: "system-ui" }}>
      <h1>RestoPOS</h1>
      <form onSubmit={submit}>
        <p>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </p>
        <p>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </p>
        {error && <p style={{ color: "red" }}>{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p style={{ color: "#555" }}>No login yet? Restaurants are set up by RestoPOS. Contact us.</p>
    </main>
  );
}
