import Link from "next/link";
import { isSuspended, tenantContext } from "@/lib/tenant";
import { auth } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export default async function BackofficeLayout({ children }: { children: React.ReactNode }) {
  const ctx = await tenantContext();
  async function signOut() {
    "use server";
    await auth.signOut();
    redirect("/login");
  }
  return (
    <div style={{ fontFamily: "system-ui" }}>
      <nav style={{ display: "flex", gap: 16, padding: 12, borderBottom: "1px solid #ccc" }}>
        <strong>RestoPOS</strong>
        <Link href="/backoffice/categories">Categories</Link>
        <Link href="/backoffice/items">Items</Link>
        <Link href="/backoffice/receipts">Receipts</Link>
        <span style={{ marginLeft: "auto" }}>{ctx.role}</span>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </nav>
      {isSuspended(ctx) && (
        <p style={{ margin: 0, padding: 12, background: "#fde8e8", color: "#8a1c1c" }}>
          This account is suspended{ctx.statusReason ? ` (${ctx.statusReason})` : ""}. You can still see your data, and
          sales already made on the tills still sync, but nothing can be changed here. Contact RestoPOS to reactivate.
        </p>
      )}
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}
