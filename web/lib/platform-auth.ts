import { auth } from "@/lib/auth/server";

// The only place that talks to Neon Auth's admin endpoints. They act with the
// signed-in admin's own session, which must carry role 'admin' in Neon Auth
// (db/scripts/platform-admin.cjs sets it). Creating a login this way does not
// touch the admin's session, unlike a sign-up, which would sign the new user in.
//
// Passwords pass through here and go nowhere else: not into the audit log, not
// into a URL, not into an error message.

type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };

function failure(error: { message?: string; code?: string } | null | undefined, fallback: string): string {
  if (error?.code === "USER_ALREADY_EXISTS" || /already exists/i.test(error?.message ?? "")) {
    return "A login with that email already exists.";
  }
  return error?.message ? `${fallback}: ${error.message}` : fallback;
}

export async function createLogin(input: { email: string; password: string; name: string }): Promise<Outcome<{ userId: string }>> {
  try {
    const res = await auth.admin.createUser({
      email: input.email,
      password: input.password,
      name: input.name,
      role: "user",
    });
    const id = res.data?.user?.id;
    if (res.error || !id) return { ok: false, message: failure(res.error, "The login could not be created") };
    return { ok: true, userId: id };
  } catch {
    return { ok: false, message: "The login service could not be reached. Nothing was created." };
  }
}

export async function setLoginPassword(userId: string, newPassword: string): Promise<Outcome<object>> {
  try {
    const res = await auth.admin.setUserPassword({ userId, newPassword });
    if (res.error) return { ok: false, message: failure(res.error, "The password could not be changed") };
    return { ok: true };
  } catch {
    return { ok: false, message: "The login service could not be reached. The password was not changed." };
  }
}

// Undo for a login whose tenant could not be created: left behind, the next
// attempt would fail with "email already exists".
export async function removeLogin(userId: string): Promise<void> {
  try {
    await auth.admin.removeUser({ userId });
  } catch {
    /* best effort: the admin sees the original error either way */
  }
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "The password must be at least 8 characters.";
  if (password.length > 128) return "The password is too long.";
  return null;
}
