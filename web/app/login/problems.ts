// What to tell someone when the sign-in service says no. Its own wording is
// kept only where nothing here covers the case, and a reply is never empty:
// a wrong password must always say so.

export type Problem = { code?: string; status?: number; message?: string; unreachable?: boolean };

// Runs a call to the sign-in service and gives back what went wrong, or null.
// The Neon client THROWS what the service refuses (a wrong password is a 401
// thrown, not an { error } returned), so both ways out are read here. Anything
// thrown without a status never reached the service.
export async function refusal(call: () => Promise<{ error?: unknown } | null | undefined>): Promise<Problem | null> {
  try {
    const res = await call();
    return (res?.error as Problem | null | undefined) ?? null;
  } catch (e) {
    const p = e as Problem | null;
    if (p && typeof p === "object" && typeof p.status === "number" && p.status > 0) return p;
    return { unreachable: true };
  }
}

const CANNOT_REACH = "Cannot reach EasyPay. Check your internet connection and try again.";
const TOO_MANY = "Too many tries. Wait a minute, then try again.";

// the service's code, in either spelling it comes in (INVALID_TOKEN, bad_jwt)
const code = (p: Problem) => (p.code ?? "").toLowerCase();
const is = (p: Problem, ...codes: string[]) => codes.includes(code(p));
const tooMany = (p: Problem) => p.status === 429 || code(p).includes("rate_limit");
const said = (p: Problem) => p.message?.trim() || "";

export function signInProblem(p: Problem): string {
  if (p.unreachable) return CANNOT_REACH;
  if (tooMany(p)) return TOO_MANY;
  if (is(p, "email_not_verified", "email_not_confirmed")) return "This email has not been confirmed yet. Contact EasyPay.";
  // an unknown email and a wrong password get the same answer, so nobody can
  // test which emails have a login
  if (is(p, "invalid_email_or_password", "invalid_password", "invalid_credentials", "user_not_found") || p.status === 401) {
    return "That email and password do not match. Check both and try again.";
  }
  return said(p) || "Sign-in failed. Try again.";
}

export function resetRequestProblem(p: Problem): string {
  if (p.unreachable) return CANNOT_REACH;
  if (tooMany(p)) return TOO_MANY;
  return "The link could not be sent. Try again in a minute, or contact EasyPay.";
}

export const LINK_EXPIRED = "This link has expired or was already used. Ask for a new one.";
export const MIN_PASSWORD = 8;
export const linkExpired = (p: Problem) => is(p, "invalid_token", "bad_jwt");

export function newPasswordProblem(p: Problem): string {
  if (p.unreachable) return CANNOT_REACH;
  if (tooMany(p)) return TOO_MANY;
  if (linkExpired(p)) return LINK_EXPIRED;
  if (is(p, "password_too_short", "weak_password")) return `Use at least ${MIN_PASSWORD} characters.`;
  if (is(p, "password_too_long")) return "That password is too long. Use a shorter one.";
  return said(p) || "The password could not be changed. Try again.";
}
