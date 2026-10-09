import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/platform";
import { THEME_COOKIE, themeOf } from "@/lib/theme";
import { AdminShell } from "./shell";

export const metadata: Metadata = { title: "EasyPay admin" };

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
    <AdminShell email={admin.email} signOut={signOut} look={themeOf((await cookies()).get(THEME_COOKIE)?.value)}>
      {children}
    </AdminShell>
  );
}
