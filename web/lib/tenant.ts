import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { ask } from "@/lib/db";

export type TenantContext = {
  userId: string;
  employeeId: string;
  tenantId: string;
  role: string | null;
  status: string;
  statusReason: string | null;
  // for the shell around every page: the restaurant's name and who is signed in
  tenantName: string | null;
  employeeName: string | null;
};

export const isSuspended = (ctx: TenantContext) => ctx.status !== "active";

// Session -> employees.auth_user_id -> tenant. A login with no restaurant goes
// to /onboarding, which explains that restaurants are set up by EasyPay (and
// sends a platform admin to the admin area).
//
// A page and the shell around it both ask who is signed in. While a page is
// being drawn the answer is worked out once and shared (cache), and it carries
// the two names the shell shows, so the shell needs no query of its own.
export const tenantContext = cache(async (): Promise<TenantContext> => {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (!user) redirect("/login");
  const found = await ask(
    `select e.id, e.tenant_id, e.name as employee_name, r.name as role, t.status, t.status_reason, t.name as tenant_name
       from employees e
       join tenants t on t.id = e.tenant_id
       left join roles r on r.id = e.role_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [user.id],
  );
  if (found.rowCount !== 1) redirect("/onboarding");
  const row = found.rows[0];
  return {
    userId: user.id,
    employeeId: row.id as string,
    tenantId: row.tenant_id as string,
    role: (row.role as string | null) ?? null,
    status: row.status as string,
    statusReason: (row.status_reason as string | null) ?? null,
    tenantName: (row.tenant_name as string | null) ?? null,
    employeeName: (row.employee_name as string | null) ?? null,
  };
});

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
