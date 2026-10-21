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
  "unknown-store": "That store does not exist.",
  "till-off": "That till is deactivated. Reactivate it first, then make the code.",
  "unknown-code": "That code does not exist.",
  "code-used": "That code set a tablet up already. To change its tablet, make a code for a replacement.",
  "unknown-role": "That role does not exist for this client.",
  "unknown-tenant": "That client does not exist.",
  "unknown-login": "That login does not exist.",
  "reason-required": "Give a reason for suspending.",
  "bad-status": "Status must be active or suspended.",
  "plan-required": "A plan name is required.",
  "bad-plan": "Choose Trial, Offline or Premium.",
  "bad-business-type": "Choose restaurant or retail.",
  "open-orders": "This client has open orders. Close or cancel them on the till first, then change the type.",
  "not-a-platform-admin": "You are no longer a platform admin.",
  // being set up, and live (migration 0104)
  "already-live": "This client is live already.",
  "already-setting-up": "This client is being set up already.",
  "has-receipts": "This client has receipts, so it stays live: from its first sale its receipts are its books.",
  "client-live": "This client is live: its sales are its books, and nothing of them is cleared from here.",
  "client-offline": "This client runs on its tablet: what it sold is on the tablet, not here. Remove its tills one by one.",
  "till-has-records":
    "That till has sales, a day, cash or clock-ins recorded, so it is not removed. While the client is being set up, Clear test activity removes it with what it recorded. A live client's till is deactivated.",
  "till-of-live-offline":
    "This client runs on its tablet and is live: what that tablet sold cannot be seen from here, so its till is not removed. Deactivate it, or make a code for a replacement.",
  // Premium MRA (migration 0116)
  "mra-needs-premium": "This client is on Premium MRA. To give it another plan, turn its MRA off first (MRA e-invoicing, Turn MRA off).",
  "bad-mra-state": "That MRA state cannot be set from here.",
  "bad-mra-id": "An EBS MRA ID is letters, digits, - and _ only, as the MRA gave it.",
  "mra-id-taken": "Another till of this client already has that EBS MRA ID.",
  // training and live, and the MRA connection (migration 0132)
  "bad-mra-move": "That move is not allowed: setting up and training go both ways, training goes live, and live is left only by turning the MRA off.",
  "mra-checklist": "The checklist is not complete yet: see what is left to do above.",
  "mra-no-connection": "Type the MRA connection first (its address and public key, below): no till can connect without it.",
  "mra-before-go-live": "The client is still being set up on EasyPay. Go live first (Being set up, Go live), then go live with the MRA.",
  "bad-mra-url": "The MRA's address starts with https://, as https://vfisc.mra.mu.",
  "bad-mra-certificate": "That is not a certificate. Open the .crt from the MRA's portal as text and paste all of it, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----.",
  "code-in-use": "That code is a tablet at work. It goes when its till is removed, and ends when a code for a replacement is made.",
};

export function adminMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return MESSAGES[raw] ?? "That did not work. Nothing was changed.";
}

// There is no billing behind a plan, but it is no longer only a label: premium
// and trial carry the premium features of a restaurant (lib/plan.ts, 0085).
// offline: the tablet alone, with no back office and no sync (lib/plan.ts, isOffline).
// Three since 0115 (the owner: "Standard is offline. So we should have trial
// Offline and Premium thats it"): every client on another plan became offline.
export const PLANS = ["trial", "offline", "premium"] as const;
// said beside the plan wherever an admin picks one
export const PLAN_HELP =
  "Premium and Trial: the cloud. Tills sync, the business has its back office (with the Sales journal), and a restaurant has the kitchen display, kitchen screens and Bookings; a shop has deposits and customer accounts. A till has the change after its next sync. Offline is the tablet alone: it does not sync, the business has no back office of its own, and it costs nothing here. You can set it up from this page (Login to back office): the tablet has that once someone taps Get changes from EasyPay on it (Settings, Support). Moved from Offline to Premium, the tablet sends everything it kept once someone taps Connect to the cloud on it (Settings, This till).";
// what the plan list offers on a client's page beside PLANS (0116): Premium
// with the MRA switched on, kept as plan premium and tenants.mra
export const PREMIUM_MRA = "premium_mra";

// What a client is given: a restaurant or a retail shop. Only set here.
export const BUSINESS_TYPES = ["restaurant", "retail"] as const;
