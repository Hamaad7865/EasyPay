import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";

// The only place that talks to Neon Auth's admin endpoints. They act with the
// signed-in admin's own session, which must carry role 'admin' in Neon Auth
// (db/scripts/platform-admin.cjs sets it). Creating a login this way does not
// touch the admin's session, unlike a sign-up, which would sign the new user in.
//
// Passwords pass through here and go nowhere else: not into the audit log, not
// into a URL, not into an error message.

type Failure = { ok: false; message: string; exists?: boolean };
type Outcome<T> = ({ ok: true } & T) | Failure;

function failure(error: { message?: string; code?: string } | null | undefined, fallback: string): Failure {
  if (error?.code === "USER_ALREADY_EXISTS" || /already exists/i.test(error?.message ?? "")) {
    return { ok: false, exists: true, message: "A login with that email already exists." };
  }
  return { ok: false, message: error?.message ? `${fallback}: ${error.message}` : fallback };
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
    if (res.error || !id) return failure(res.error, "The login could not be created");
    return { ok: true, userId: id };
  } catch {
    return { ok: false, message: "The login service could not be reached. Nothing was created." };
  }
}

export async function setLoginPassword(userId: string, newPassword: string): Promise<Outcome<object>> {
  try {
    const res = await auth.admin.setUserPassword({ userId, newPassword });
    if (res.error) return failure(res.error, "The password could not be changed");
    return { ok: true };
  } catch {
    return { ok: false, message: "The login service could not be reached. The password was not changed." };
  }
}

// A login for a restaurant: a new one, or one that already exists for that
// email and belongs to nobody yet (someone who registered with the auth
// service directly, or a login left over from a restaurant that never got
// made). An existing login gets the password typed here, so the admin always
// knows what to hand over. `created` tells the caller whether it may undo.
export async function loginForRestaurant(input: {
  email: string;
  password: string;
  name: string;
}): Promise<Outcome<{ userId: string; created: boolean }>> {
  const made = await createLogin(input);
  if (made.ok) return { ok: true, userId: made.userId, created: true };
  if (!made.exists) return made;
  const found = await db().query(
    `select u.id,
            exists (select 1 from employees e where e.auth_user_id = u.id) as linked,
            exists (select 1 from platform.admins a where a.auth_user_id = u.id and a.revoked_at is null) as admin
       from neon_auth."user" u where lower(u.email) = $1`,
    [input.email.toLowerCase()],
  );
  const row = found.rows[0] as { id: string; linked: boolean; admin: boolean } | undefined;
  if (!row) return made;
  if (row.admin) return { ok: false, message: "That email is a platform admin's login. Use another email." };
  if (row.linked) return { ok: false, message: "That email already belongs to a client." };
  const reset = await setLoginPassword(row.id, input.password);
  if (!reset.ok) return reset;
  return { ok: true, userId: row.id, created: false };
}

// Undo for a login whose tenant could not be created: left behind, the next
// attempt would fail with "email already exists". Only for logins this
// request created, never for one that existed before.
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
