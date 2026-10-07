import { isSuspended, tenantContext } from "@/lib/tenant";
import { auth } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { GROUPS } from "./nav";
import { Side } from "./side";
import { words } from "@/lib/mode";

export default async function BackofficeLayout({ children }: { children: React.ReactNode }) {
  // who is signed in, with the two names shown here: the page asks the same
  // question and the answer is shared, so the shell costs no query of its own
  const ctx = await tenantContext();
  async function signOut() {
    "use server";
    await auth.signOut();
    redirect("/login");
  }
  // how the menu was left in this browser, known before the page is drawn
  const jar = await cookies();
  const groups = jar.get("bo-groups")?.value;
  return (
    <div className="bo">
      <Side
        mode={ctx.mode}
        drawn={Date.now()}
        folded={jar.get("bo-menu")?.value === "closed"}
        opened={groups == null ? null : groups.split(".").filter((g) => GROUPS.some((x) => x.id === g))}
        restaurant={ctx.tenantName ?? words(ctx.mode).Place}
        // the start of the restaurant's id: what to quote to EasyPay support
        id={ctx.tenantId.slice(0, 8).toUpperCase()}
        employee={ctx.employeeName}
        role={ctx.role}
        signOut={signOut}
      />
      <div className="bo-body">
        <main className="bo-main">
          {isSuspended(ctx) && (
            <div className="bo-banner danger">
              <strong>This account is suspended{ctx.statusReason ? ` (${ctx.statusReason})` : ""}.</strong>
              You can still see your data, and sales already made on the tills still sync, but nothing can be changed
              here. Contact EasyPay to reactivate.
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
