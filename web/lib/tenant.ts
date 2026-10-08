import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { asMode, type Mode } from "@/lib/mode";
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
  // for the shell around every page: the restaurant's name and who is signed in
  tenantName: string | null;
  employeeName: string | null;
};

export const isSuspended = (ctx: TenantContext) => ctx.status !== "active";

// Session -> employees.auth_user_id -> tenant. A login with no restaurant goes
// to /onboarding, which explains that restaurants are set up by EasyPay (and
// sends a platform admin to the admin area). So does a login whose role does
// not hold "Sign in to the back office" (backoffice.access): it is a login
// for the tills, and the page says so.
//
// A page and the shell around it both ask who is signed in. While a page is
// being drawn the answer is worked out once and shared (cache), and it carries
// the two names the shell shows, so the shell needs no query of its own.
export const tenantContext = cache(async (): Promise<TenantContext> => {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (!user) redirect("/login");
  const found = await ask(
    `select e.id, e.tenant_id, e.name as employee_name, r.name as role, t.status, t.status_reason, t.name as tenant_name, t.business_type,
            has_perm(e.id, 'backoffice.access') as may_enter
       from employees e
       join tenants t on t.id = e.tenant_id
       left join roles r on r.id = e.role_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [user.id],
  );
  if (found.rowCount !== 1 || !found.rows[0].may_enter) redirect("/onboarding");
  const row = found.rows[0];
  return {
    userId: user.id,
    employeeId: row.id as string,
    tenantId: row.tenant_id as string,
    role: (row.role as string | null) ?? null,
    status: row.status as string,
    statusReason: (row.status_reason as string | null) ?? null,
    mode: asMode(row.business_type),
    tenantName: (row.tenant_name as string | null) ?? null,
    employeeName: (row.employee_name as string | null) ?? null,
  };
});

// How a login stands with the back office, for the page a login that is kept
// out lands on: "ok" it may come in; "no-access" it is one of a business's
// logins, but its role does not hold "Sign in to the back office"; "none" it
// is linked to no business, or was switched off. The same question
// tenantContext asks, so the two cannot disagree and send someone round.
export type Standing = "ok" | "no-access" | "none";
export async function loginStanding(userId: string): Promise<Standing> {
  const found = await ask(
    `select has_perm(e.id, 'backoffice.access') as may_enter
       from employees e
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [userId],
  );
  if (found.rowCount !== 1) return "none";
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
