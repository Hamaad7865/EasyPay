"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { AuthCard } from "../login/auth-card";
import { PasswordInput } from "../login/password-input";
import { LINK_EXPIRED, MIN_PASSWORD, linkExpired, newPasswordProblem, refusal } from "../login/problems";

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"form" | "done" | "expired">(token ? "form" : "expired");

  // The token opens this login to whoever holds it: take it out of the address
  // bar (and so out of the history) once the page has it.
  useEffect(() => {
    window.history.replaceState(null, "", "/reset-password");
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== again) return setError("The two passwords are not the same. Type them again.");
    setBusy(true);
    const no = await refusal(() => authClient.resetPassword({ newPassword: password, token }));
    if (!no) return setState("done");
    if (linkExpired(no)) return setState("expired");
    setError(newPasswordProblem(no));
    setBusy(false);
  }

  if (state === "done") {
    return (
      <AuthCard>
        <h1>Your password is changed</h1>
        <p className="auth-lede">Sign in with the new one, here and on the tablet the next time it asks.</p>
        <Link href="/login" className="auth-button">
          Sign in
        </Link>
      </AuthCard>
    );
  }

  if (state === "expired") {
    return (
      <AuthCard>
        <h1>This link no longer works</h1>
        <p className="auth-lede">{LINK_EXPIRED} It only takes a minute.</p>
        <Link href="/login" className="auth-button">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>Choose a new password</h1>
      <p className="auth-lede">At least {MIN_PASSWORD} characters. You will use it for the back office and to sign in on the tablet.</p>
      <form onSubmit={save}>
        <label htmlFor="new-password">New password</label>
        <PasswordInput id="new-password" autoComplete="new-password" value={password} onChange={setPassword} minLength={MIN_PASSWORD} autoFocus />
        <label htmlFor="new-password-again">Type it again</label>
        <PasswordInput id="new-password-again" autoComplete="new-password" value={again} onChange={setAgain} />
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save the new password"}
        </button>
      </form>
    </AuthCard>
  );
}
