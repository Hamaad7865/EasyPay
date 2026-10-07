"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bug, Store } from "lucide-react";
import { Wait } from "../backoffice/busy";

// The admin area's pages, in the bar. A restaurant's own page counts as being
// among the restaurants.
const PAGES = [
  { href: "/admin", label: "Restaurants", icon: Store, here: (p: string) => p === "/admin" || p.startsWith("/admin/tenants") },
  { href: "/admin/crashes", label: "Crashes", icon: Bug, here: (p: string) => p.startsWith("/admin/crashes") },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="adm-nav" aria-label="Admin">
      {PAGES.map(({ href, label, icon: Icon, here }) => (
        <Link key={href} href={href} className={here(path) ? "on" : undefined} aria-current={path === href ? "page" : undefined}>
          <Icon aria-hidden="true" strokeWidth={1.9} />
          {label}
          <Wait />
        </Link>
      ))}
    </nav>
  );
}
