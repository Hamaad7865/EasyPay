import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
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
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}
