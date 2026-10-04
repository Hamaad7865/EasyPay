"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Only what exists. A section is added here when its pages are built.
const HOME = "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z";
const TAG = "M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z";
const LIST = "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z";
const PERSON = "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z";
const GRID = "M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z";
const RECEIPT = "M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z";

const SECTIONS: { title: string | null; links: { href: string; label: string; icon: string }[] }[] = [
  { title: null, links: [{ href: "/backoffice", label: "Home", icon: HOME }] },
  {
    title: "Menu management",
    links: [
      { href: "/backoffice/categories", label: "Categories", icon: TAG },
      { href: "/backoffice/items", label: "Items", icon: LIST },
    ],
  },
  {
    title: "Configuration",
    links: [
      { href: "/backoffice/tables", label: "Tables", icon: GRID },
      { href: "/backoffice/staff", label: "Staff", icon: PERSON },
    ],
  },
  { title: "Reports", links: [{ href: "/backoffice/receipts", label: "Receipts", icon: RECEIPT }] },
];

export function SideNav() {
  const path = usePathname();
  const isOn = (href: string) => (href === "/backoffice" ? path === href : path.startsWith(href));
  return (
    <nav className="bo-nav">
      {SECTIONS.map((s) => (
        <div key={s.title ?? "top"}>
          {s.title && <div className="bo-nav-group">{s.title}</div>}
          {s.links.map((l) => (
            <Link key={l.href} href={l.href} className={isOn(l.href) ? "on" : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={l.icon} />
              </svg>
              {l.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
