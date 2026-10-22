import { AS_COOKIE, AS_PATH, isSuspended, tenantContext } from "@/lib/tenant";
import { auth } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { GROUPS } from "./nav";
import { Over, Side } from "./side";
import { words } from "@/lib/mode";
import { onMra } from "@/lib/mra";
import { THEME_COOKIE, themeOf } from "@/lib/theme";

export default async function BackofficeLayout({ children }: { children: React.ReactNode }) {
  // who is signed in, with the two names shown here: the page asks the same
  // question and the answer is shared, so the shell costs no query of its own
  const ctx = await tenantContext();
  async function signOut() {
    "use server";
    await auth.signOut();
    redirect("/login");
  }
  // EasyPay's admin, in an offline client's back office to set it up (lib/tenant.ts, adminInside), goes
  // back to that client's page in /admin: the cookie that named the client is taken away.
  const client = ctx.tenantId;
  async function leave() {
    "use server";
    (await cookies()).set(AS_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: AS_PATH, maxAge: 0 });
    redirect(`/admin/tenants/${client}`);
  }
  // how the menu was left in this browser, known before the page is drawn
  const jar = await cookies();
  const groups = jar.get("bo-groups")?.value;
  return (
    <div className="bo">
      <Side
        mode={ctx.mode}
        premium={ctx.premium}
        mra={onMra(ctx.mra)}
        drawn={Date.now()}
        folded={jar.get("bo-menu")?.value === "closed"}
        look={themeOf(jar.get(THEME_COOKIE)?.value)}
        opened={groups == null ? null : groups.split(".").filter((g) => GROUPS.some((x) => x.id === g))}
        restaurant={ctx.tenantName ?? words(ctx.mode).Place}
        // the start of the restaurant's id: what to quote to EasyPay support
        id={ctx.tenantId.slice(0, 8).toUpperCase()}
        employee={ctx.admin ? "EasyPay admin" : ctx.employeeName}
        role={ctx.admin ? `for ${ctx.employeeName ?? "the owner"}` : ctx.role}
        signOut={signOut}
      />
      <div className="bo-body">
        <main className="bo-main">
          {ctx.admin && (
            <form action={leave} className="bo-banner warn">
              <strong>You are in {ctx.tenantName ?? "this client"}&apos;s back office, as EasyPay</strong>
              This business is on the offline plan and runs on its tablet. What you set up here (products, prices, taxes, staff, printers, tables,
              the receipt) is on the tablet once someone taps Get changes from EasyPay on it, under Settings, Support, with the tablet online.
              Its sales and its stock are on the tablet only: reports and stock figures here are not the business&apos;s.
              <div style={{ marginTop: 10 }}>
                <button type="submit" className="btn-quiet">Back to the admin</button>
              </div>
            </form>
          )}
          {isSuspended(ctx) && (
            <div className="bo-banner danger">
              <strong>This account is suspended{ctx.statusReason ? ` (${ctx.statusReason})` : ""}.</strong>
              You can still see your data, and sales already made on the tills still sync, but nothing can be changed
              here. Contact EasyPay to reactivate.
            </div>
          )}
          <Over mode={ctx.mode} premium={ctx.premium} mra={onMra(ctx.mra)} />
          {children}
        </main>
      </div>
    </div>
  );
}
