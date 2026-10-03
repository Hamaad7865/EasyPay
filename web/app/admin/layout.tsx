import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/platform";

export const metadata: Metadata = { title: "RestoPOS admin" };

// The platform admin area. The check here hides the shell; every page and
// every action below repeats it, because a layout is not a security boundary.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  async function signOut() {
    "use server";
    await auth.signOut();
    redirect("/login");
  }
  return (
    <div style={{ fontFamily: "system-ui" }}>
      <nav style={{ display: "flex", gap: 16, padding: 12, borderBottom: "1px solid #ccc", alignItems: "center" }}>
        <strong>RestoPOS admin</strong>
        <Link href="/admin">Restaurants</Link>
        <span style={{ marginLeft: "auto" }}>{admin.email}</span>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <div style={{ padding: 16, maxWidth: 1100 }}>{children}</div>
    </div>
  );
}
