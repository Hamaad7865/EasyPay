import Link from "next/link";
import { LogOut } from "lucide-react";
import { Submit } from "../backoffice/busy";
import type { Theme } from "@/lib/theme";
import { ThemeSwitch } from "../theme";
import { AdminNav } from "./nav";

// The frame of the admin area: one bar across the top (which EasyPay this is,
// its pages, who is signed in, the light or dark switch and the way out) and
// the page under it. The page sits in the back office's .bo-main, so it is
// put together from the same tables, fields and buttons.
export function AdminShell({ email, signOut, look, children }: { email: string; signOut: () => Promise<void>; look: Theme | null; children: React.ReactNode }) {
  return (
    <div className="bo adm">
      <header className="adm-bar">
        <Link href="/admin" className="adm-brand" aria-label="EasyPay admin">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" />
          <span>
            Easy<span className="bo-brand-pos">Pay</span>
          </span>
          <span className="adm-tag">Admin</span>
        </Link>
        <AdminNav />
        <div className="bo-user adm-user">
          <span className="bo-avatar" aria-hidden="true">{email.charAt(0).toUpperCase()}</span>
          <span>
            <b title={email}>{email}</b>
            <small>Platform admin</small>
          </span>
          <ThemeSwitch initial={look} />
          <form action={signOut}>
            <Submit title="Sign out" aria-label="Sign out">
              <LogOut aria-hidden="true" />
            </Submit>
          </form>
        </div>
      </header>
      <main className="bo-main adm-main">{children}</main>
    </div>
  );
}
