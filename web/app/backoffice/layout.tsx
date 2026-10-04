import { isSuspended, tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { LogOut, Store } from "lucide-react";
import { SideNav } from "./side-nav";

export default async function BackofficeLayout({ children }: { children: React.ReactNode }) {
  const ctx = await tenantContext();
  const who = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select (select name from tenants where id = $1) as tenant,
                (select name from employees where id = $2 and tenant_id = $1) as employee`,
        [ctx.tenantId, ctx.employeeId],
      )
      .then((r) => r.rows[0] as { tenant: string | null; employee: string | null }),
  );
  async function signOut() {
    "use server";
    await auth.signOut();
    redirect("/login");
  }
  const restaurant = who.tenant ?? "Restaurant";
  return (
    <div className="bo">
      <aside className="bo-side">
        <div className="bo-brand">
          <span className="bo-brand-mark">R</span>RestoPOS
        </div>
        <div className="bo-restaurant" title={restaurant}>
          <Store aria-hidden="true" />
          <span>{restaurant}</span>
        </div>
        <SideNav />
      </aside>
      <div className="bo-body">
        <header className="bo-top">
          <span className="bo-top-name">{restaurant}</span>
          {/* the start of the restaurant's id: what to quote to RestoPOS support */}
          <span className="bo-top-id">ID: {ctx.tenantId.slice(0, 8).toUpperCase()}</span>
          <span className="bo-top-spacer" />
          <span className="bo-top-user">
            <span className="bo-avatar">{(who.employee ?? "?").trim().slice(0, 1).toUpperCase()}</span>
            <span>
              {who.employee ?? "Signed in"}
              {ctx.role && <small>{ctx.role}</small>}
            </span>
          </span>
          <form action={signOut}>
            <button type="submit">
              <LogOut aria-hidden="true" width={15} height={15} />
              Sign out
            </button>
          </form>
        </header>
        <main className="bo-main">
          {isSuspended(ctx) && (
            <div className="bo-banner danger">
              <strong>This account is suspended{ctx.statusReason ? ` (${ctx.statusReason})` : ""}.</strong>
              You can still see your data, and sales already made on the tills still sync, but nothing can be changed
              here. Contact RestoPOS to reactivate.
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
