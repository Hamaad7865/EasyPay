import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";

// The platform admin ("super admin"): the one who creates restaurants and
// their logins. It is a login with a live row in platform.admins. That schema
// is invisible to the tenant role, so everything here runs on the owner
// connection, on the server only, and never inside withTenant().

export type PlatformAdmin = { userId: string; email: string };

// null when nobody is signed in or the login is not a platform admin
export async function platformAdminOrNull(): Promise<PlatformAdmin | null> {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (!user) return null;
  const found = await db().query(
    `select email from platform.admins where auth_user_id = $1 and revoked_at is null`,
    [user.id],
  );
  if (found.rowCount !== 1) return null;
  return { userId: user.id, email: found.rows[0].email as string };
}

// Every admin page and every admin action starts with this. A signed-in login
// that is not an admin gets a 404: the area does not exist for it.
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const { data } = await auth.getSession();
  if (!data?.user) redirect("/login");
  const admin = await platformAdminOrNull();
  if (!admin) notFound();
  return admin;
}

// The codes the platform.* functions raise, in words an admin can act on.
const MESSAGES: Record<string, string> = {
  "name-required": "A name is required.",
  "bad-store-code": "Store code must be 1 to 12 letters or digits.",
  "owner-login-required": "The owner login could not be created.",
  "login-required": "The login could not be created.",
  "login-already-linked": "That login already belongs to a client.",
  "login-is-platform-admin": "That email is a platform admin's login. Use another email.",
  "store-code-taken": "That store code is already used by this client.",
  "unknown-till": "That till does not exist.",
  "unknown-role": "That role does not exist for this client.",
  "unknown-tenant": "That client does not exist.",
  "unknown-login": "That login does not exist.",
  "reason-required": "Give a reason for suspending.",
  "bad-status": "Status must be active or suspended.",
  "plan-required": "A plan name is required.",
  "bad-business-type": "Choose restaurant or retail.",
  "open-orders": "This client has open orders. Close or cancel them on the till first, then change the type.",
  "not-a-platform-admin": "You are no longer a platform admin.",
};

export function adminMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return MESSAGES[raw] ?? "That did not work. Nothing was changed.";
}

// Plans are plain labels: there is no billing behind them yet.
export const PLANS = ["trial", "standard", "premium"] as const;

// What a client is given: a restaurant or a retail shop. Only set here.
export const BUSINESS_TYPES = ["restaurant", "retail"] as const;
