"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  BadgePercent,
  BarChart3,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  Clock,
  Contact,
  Database,
  FileText,
  LayoutDashboard,
  LayoutGrid,
  ListOrdered,
  type LucideIcon,
  Percent,
  Printer,
  Receipt,
  ReceiptText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Timer,
  Users,
  UtensilsCrossed,
} from "lucide-react";

// Only what exists. A section is added here when its pages are built.
const SECTIONS: { title: string | null; links: { href: string; label: string; icon: LucideIcon }[] }[] = [
  { title: null, links: [{ href: "/backoffice", label: "Dashboard", icon: LayoutDashboard }] },
  {
    title: "Reports",
    links: [
      { href: "/backoffice/reports/sales", label: "Sales summary", icon: BarChart3 },
      { href: "/backoffice/reports/items", label: "Item sales", icon: ListOrdered },
      { href: "/backoffice/reports/orders", label: "Order details", icon: ClipboardList },
      { href: "/backoffice/reports/tax", label: "Tax", icon: Percent },
      { href: "/backoffice/reports/shifts", label: "Sales periods", icon: Timer },
      { href: "/backoffice/reports/day-close", label: "Day closing", icon: CalendarCheck },
      { href: "/backoffice/reports/timecards", label: "Time cards", icon: Clock },
      { href: "/backoffice/receipts", label: "Receipts", icon: Receipt },
    ],
  },
  {
    title: "Menu",
    links: [
      { href: "/backoffice/categories", label: "Categories", icon: Tags },
      { href: "/backoffice/items", label: "Items", icon: UtensilsCrossed },
      { href: "/backoffice/addons", label: "Add-ons", icon: SlidersHorizontal },
      { href: "/backoffice/taxes", label: "Taxes", icon: FileText },
      { href: "/backoffice/discounts", label: "Discounts", icon: BadgePercent },
      { href: "/backoffice/stock", label: "Stock", icon: Boxes },
    ],
  },
  {
    title: "Restaurant",
    links: [
      { href: "/backoffice/tables", label: "Tables", icon: LayoutGrid },
      { href: "/backoffice/bookings", label: "Bookings", icon: CalendarClock },
      { href: "/backoffice/customers", label: "Customers", icon: Contact },
      { href: "/backoffice/printers", label: "Printers", icon: Printer },
      { href: "/backoffice/receipt-design", label: "Receipt design", icon: ReceiptText },
    ],
  },
  {
    title: "Settings",
    links: [
      { href: "/backoffice/settings", label: "POS settings", icon: Settings2 },
      { href: "/backoffice/company", label: "Company details", icon: Building2 },
      { href: "/backoffice/staff", label: "Staff", icon: Users },
      { href: "/backoffice/roles", label: "Roles and permissions", icon: ShieldCheck },
      { href: "/backoffice/data", label: "Backup and data", icon: Database },
    ],
  },
];

export function SideNav() {
  const path = usePathname();
  const isOn = (href: string) => (href === "/backoffice" ? path === href : path === href || path.startsWith(href + "/"));
  // The list scrolls without a bar, so the page that is open is brought into view.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = nav.current;
    const on = el?.querySelector("a.on");
    if (!el || !on) return;
    const box = el.getBoundingClientRect();
    const r = on.getBoundingClientRect();
    if (r.top < box.top) el.scrollTop -= box.top - r.top + 8;
    else if (r.bottom > box.bottom) el.scrollTop += r.bottom - box.bottom + 8;
  }, [path]);
  return (
    <nav className="bo-nav" ref={nav}>
      {SECTIONS.map((s) => (
        <div key={s.title ?? "top"}>
          {s.title && <div className="bo-nav-group">{s.title}</div>}
          {s.links.map((l) => (
            <Link key={l.href} href={l.href} className={isOn(l.href) ? "on" : undefined}>
              <l.icon aria-hidden="true" strokeWidth={1.9} />
              {l.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
