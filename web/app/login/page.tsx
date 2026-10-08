"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { AuthCard } from "./auth-card";
import { PasswordInput } from "./password-input";
import { refusal, resetRequestProblem, signInProblem } from "./problems";

// Sign-in only. Logins are created by the platform admin; there is no sign-up.
// Someone who forgot their password asks for a link from here; the link opens
// /reset-password.
export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"signin" | "forgot" | "sent">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const go = (to: typeof step) => {
    setError("");
    setStep(to);
  };

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const no = await refusal(() => authClient.signIn.email({ email: email.trim(), password }));
    if (no) {
      setError(signInProblem(no));
      setBusy(false);
      return;
    }
    // Everyone goes to the back office, which sends a platform admin on to
    // /admin (a login with no restaurant lands on the page that says so, and
    // that page knows an admin). Not "/": at easypaypos.pages.dev that is the
    // public site. The button stays busy until the page is there.
    router.push("/backoffice");
    router.refresh();
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    // The service answers the same whether or not the email has a login.
    const no = await refusal(() =>
      authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${window.location.origin}/reset-password` }),
    );
    if (no) setError(resetRequestProblem(no));
    else setStep("sent");
    setBusy(false);
  }

  const problem = error && (
    <p className="auth-error" role="alert">
      {error}
    </p>
  );

  if (step === "sent") {
    return (
      <AuthCard>
        <h1>Check your email</h1>
        <p className="auth-lede">
          If <b>{email.trim()}</b> is an EasyPay login, a link to choose a new password is on its way. The link works once.
        </p>
        <p className="auth-note">Nothing after a few minutes? Look in the spam folder, or send it again.</p>
        <button type="button" onClick={() => go("signin")}>
          Back to sign in
        </button>
        <p className="auth-aside auth-aside-center">
          <button type="button" className="auth-link" onClick={() => go("forgot")}>
            Send it again
          </button>
        </p>
      </AuthCard>
    );
  }

  if (step === "forgot") {
    return (
      <AuthCard>
        <h1>Forgot your password?</h1>
        <p className="auth-lede">Enter the email you sign in with. We will send you a link to choose a new password.</p>
        <form onSubmit={sendLink}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          {problem}
          <button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send the link"}
          </button>
        </form>
        <p className="auth-aside auth-aside-center">
          <button type="button" className="auth-link" onClick={() => go("signin")}>
            Back to sign in
          </button>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>Sign in to your back office</h1>
      <p className="auth-lede">Your menu, your reports and your settings, wherever you are.</p>
      <form onSubmit={signIn}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label htmlFor="password">Password</label>
        <PasswordInput id="password" autoComplete="current-password" value={password} onChange={setPassword} />
        <p className="auth-aside">
          <button type="button" className="auth-link" onClick={() => go("forgot")}>
            Forgot password?
          </button>
        </p>
        {problem}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="auth-foot">No login yet? Restaurants are set up by EasyPay. Contact us.</p>
    </AuthCard>
  );
}
