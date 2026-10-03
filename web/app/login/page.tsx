"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res =
      mode === "in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name });
    if (res.error) {
      setError(res.error.message ?? "Sign-in failed");
      return;
    }
    router.push("/backoffice");
    router.refresh();
  }

  return (
    <main style={{ maxWidth: 400, margin: "80px auto", fontFamily: "system-ui" }}>
      <h1>RestoPOS</h1>
      <div>
        <button onClick={() => setMode("in")} disabled={mode === "in"}>
          Sign in
        </button>{" "}
        <button onClick={() => setMode("up")} disabled={mode === "up"}>
          Sign up
        </button>
      </div>
      <form onSubmit={submit}>
        {mode === "up" && (
          <p>
            <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
          </p>
        )}
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
        <button type="submit">{mode === "in" ? "Sign in" : "Create account"}</button>
      </form>
    </main>
  );
}
