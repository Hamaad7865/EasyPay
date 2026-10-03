import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";

export type TenantContext = {
  userId: string;
  employeeId: string;
  tenantId: string;
  role: string | null;
  status: string;
  statusReason: string | null;
};

export const isSuspended = (ctx: TenantContext) => ctx.status !== "active";

// Session -> employees.auth_user_id -> tenant. A login with no restaurant goes
// to /onboarding, which explains that restaurants are set up by RestoPOS (and
// sends a platform admin to the admin area).
export async function tenantContext(): Promise<TenantContext> {
  const { data } = await auth.getSession();
  const user = data?.user;
  if (!user) redirect("/login");
  const found = await db().query(
    `select e.id, e.tenant_id, r.name as role, t.status, t.status_reason
       from employees e
       join tenants t on t.id = e.tenant_id
       left join roles r on r.id = e.role_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [user.id],
  );
  if (found.rowCount !== 1) redirect("/onboarding");
  return {
    userId: user.id,
    employeeId: found.rows[0].id as string,
    tenantId: found.rows[0].tenant_id as string,
    role: (found.rows[0].role as string | null) ?? null,
    status: found.rows[0].status as string,
    statusReason: (found.rows[0].status_reason as string | null) ?? null,
  };
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
  const allowed = await db().query(`select has_perm($1, $2) as ok`, [ctx.employeeId, perm]);
  if (!allowed.rows[0]?.ok) throw new Error(`Forbidden: ${perm} required`);
  return ctx;
}
