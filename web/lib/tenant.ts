import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { asMode, type Mode } from "@/lib/mode";
import { hasPremium, isOffline } from "@/lib/plan";
import { asMra, type MraState } from "@/lib/mra";
import { auth } from "@/lib/auth/server";
import { ask } from "@/lib/db";

export type TenantContext = {
  userId: string;
  employeeId: string;
  tenantId: string;
  role: string | null;
  status: string;
  statusReason: string | null;
  // a restaurant or a retail shop: decides which pages exist and what they are called
  mode: Mode;
  // the plan carries the premium pages (bookings, kitchen screens): lib/plan.ts
  premium: boolean;
  // Premium MRA: where the client stands with the MRA's e-invoicing (lib/mra.ts, 0116)
  mra: MraState;
  // for the shell around every page: the restaurant's name and who is signed in
  tenantName: string | null;
  employeeName: string | null;
  // EasyPay's platform admin is in here, standing in for the business's owner (adminInside, below)
  admin: boolean;
};

export const isSuspended = (ctx: TenantContext) => ctx.status !== "active";

// EasyPay inside a client's back office.
//
// A business on the offline plan has no back office of its own: that is part
// of Premium. But EasyPay sets such a business up for its owner (the menu,
// the taxes, the staff typed on a computer, the day it is handed over and
// whenever it asks), and the tablet fetches that when someone taps "Get
// changes from EasyPay" on it. So the platform admin opens its back office
// from the client's page in /admin ("Login to back office"), which leaves
// this cookie naming the client.
//
// The cookie alone opens nothing. On every request the login must still be a
// platform admin, and the client must still be on the offline plan: a client
// on another plan has a back office of its own, with its sales in it, and
// that one is not opened from here. Inside, the admin stands in for the
// business's owner (the one of its people whose role holds everything), so
// what is saved is saved as the owner would have saved it; that the admin
// came in is written in /admin's own list of what was done.
export const AS_COOKIE = "easypay-as";
// only the back office is sent it
export const AS_PATH = "/backoffice";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Who the platform admin stands in for in this client's back office, or null
// when there is nothing to open: the login is not a platform admin, the
// client is not on the offline plan, or it has nobody who holds everything.
// The admin area asks this before it leaves the cookie, and every request of
// the back office asks it again.
export async function adminInside(userId: string, tenantId: string): Promise<TenantContext | null> {
  if (!UUID.test(tenantId)) return null;
  const found = await ask(
    `select t.id as tenant_id, t.status, t.status_reason, t.name as tenant_name, t.business_type, t.plan,
            o.id, o.name as employee_name, o.role
       from tenants t
       join platform.admins a on a.auth_user_id = $1 and a.revoked_at is null
       left join lateral (
         select e.id, e.name, r.name as role
           from employees e
           join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id and r.deleted_at is null
          where e.tenant_id = t.id and e.deleted_at is null and e.is_active and r.permissions ? '*'
          order by (e.auth_user_id is not null) desc, e.created_at
          limit 1
       ) o on true
      where t.id = $2 and t.deleted_at is null and lower(btrim(coalesce(t.plan, ''))) = 'offline'`,
    [userId, tenantId],
  );
  // (the statement is held to its rules in db/tests/admin-inside.test.cjs, which reads it from this file)
  const row = found.rows[0];
  if (!row || !row.id || !isOffline(row.plan)) return null;
  return {
    userId,
    employeeId: row.id as string,
    tenantId: row.tenant_id as string,
    role: (row.role as string | null) ?? null,
    status: row.status as string,
    statusReason: (row.status_reason as string | null) ?? null,
    mode: asMode(row.business_type),
    premium: hasPremium(row.plan),
    // an offline client is never on MRA (0116: MRA is premium only)
    mra: "off",
    tenantName: (row.tenant_name as string | null) ?? null,
    employeeName: (row.employee_name as string | null) ?? null,
    admin: true,
  };
}

// Session -> employees.auth_user_id -> tenant. A login with no restaurant goes
// to /onboarding, which explains that restaurants are set up by EasyPay (and
// sends a platform admin to the admin area). So does a login whose role does
// not hold "Sign in to the back office" (backoffice.access), and the page
// says which of the two it is.
//
// A page and the shell around it both ask who is signed in. While a page is
// being drawn the answer is worked out once and shared (cache), and it carries
// the two names the shell shows, so the shell needs no query of its own.
export const tenantContext = cache(async (): Promise<TenantContext> => {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (!user) redirect("/login");
  // EasyPay's admin, come in from /admin to set an offline client up: asked
  // only of a browser that carries the cookie, so nobody else's page pays for it
  const named = (await cookies()).get(AS_COOKIE)?.value;
  if (named) {
    const inside = await adminInside(user.id, named);
    if (inside) return inside;
  }
  const found = await ask(
    `select e.id, e.tenant_id, e.name as employee_name, r.name as role, t.status, t.status_reason, t.name as tenant_name, t.business_type, t.plan, t.mra,
            has_perm(e.id, 'backoffice.access') as may_enter
       from employees e
       join tenants t on t.id = e.tenant_id
       left join roles r on r.id = e.role_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [user.id],
  );
  // a business on the offline plan has no back office: it runs on its tablet, and the page it lands on says so
  if (found.rowCount !== 1 || !found.rows[0].may_enter || isOffline(found.rows[0].plan)) redirect("/onboarding");
  const row = found.rows[0];
  return {
    userId: user.id,
    employeeId: row.id as string,
    tenantId: row.tenant_id as string,
    role: (row.role as string | null) ?? null,
    status: row.status as string,
    statusReason: (row.status_reason as string | null) ?? null,
    mode: asMode(row.business_type),
    premium: hasPremium(row.plan),
    mra: asMra(row.mra),
    tenantName: (row.tenant_name as string | null) ?? null,
    employeeName: (row.employee_name as string | null) ?? null,
    admin: false,
  };
});

// How a login stands with the back office, for the page a login that is kept
// out lands on: "ok" it may come in; "no-access" it is one of a business's
// logins, but its role does not hold "Sign in to the back office"; "none" it
// is linked to no business, or was switched off. The same question
// tenantContext asks, so the two cannot disagree and send someone round.
// "offline": its business is on the offline plan, which has no back office.
export type Standing = "ok" | "no-access" | "none" | "offline";
export async function loginStanding(userId: string): Promise<Standing> {
  const found = await ask(
    `select has_perm(e.id, 'backoffice.access') as may_enter, t.plan
       from employees e join tenants t on t.id = e.tenant_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [userId],
  );
  if (found.rowCount !== 1) return "none";
  if (isOffline(found.rows[0].plan)) return "offline";
  return found.rows[0].may_enter ? "ok" : "no-access";
}

// A page that belongs to one kind of business does not exist for the other:
// a shop that types the address of Tables gets "not found", the same as for
// any page that was never built.
export async function onlyFor(mode: Mode): Promise<TenantContext> {
  const ctx = await tenantContext();
  if (ctx.mode !== mode) notFound();
  return ctx;
}

export async function bearerToken(): Promise<string | null> {
  const { data } = await auth.token();
  return data?.token ?? null;
}

// Server-action guard: the caller's employee must hold the permission, and the
// restaurant must be active (a suspended one can look but not change).
// Throws (never returns false) so failures cannot be ignored by callers.
export async function requirePerm(perm: string): Promise<TenantContext> {
  const ctx = await tenantContext();
  if (isSuspended(ctx)) throw new Error("This account is suspended. Nothing was changed.");
  const allowed = await ask(`select has_perm($1, $2) as ok`, [ctx.employeeId, perm]);
  if (!allowed.rows[0]?.ok) throw new Error(`Forbidden: ${perm} required`);
  return ctx;
}
