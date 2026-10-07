import {
  BadgePercent,
  BarChart3,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ChartNoAxesCombined,
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
  Store,
  Tags,
  TrendingUp,
  Truck,
  UserRoundCheck,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import type { Mode } from "@/lib/mode";

// Every page of the back office, once. The side menu draws its groups from
// this list and the search finds pages in it, so the two cannot drift apart.
// Only what exists: a page is added here when it is built. `words` are other
// things someone might type when looking for the page.
// `only`: the one kind of business that has this page (none: both have it).
// `retail`: what a shop calls it, when that differs.
export type NavLink = { href: string; label: string; icon: LucideIcon; words?: string; only?: Mode; retail?: string };
export type NavGroup = { id: string; title: string; icon: LucideIcon; links: NavLink[]; retail?: string };
// The number beside a page in the menu, and what it counts, said in full (counts/route.ts).
export type NavCount = { n: number; say: string; tone?: "red" };

export const HOME: NavLink = { href: "/backoffice", label: "Dashboard", icon: LayoutDashboard, words: "home today overview right now" };

export const GROUPS: NavGroup[] = [
  {
    id: "insights",
    title: "Insights",
    icon: ChartNoAxesCombined,
    links: [
      { href: "/backoffice/insights/sales", label: "Sales patterns", icon: CalendarRange, words: "busiest day hour peak heatmap trend compare average check" },
      { href: "/backoffice/insights/menu", label: "Menu performance", retail: "Product performance", icon: TrendingUp, words: "best sellers popular slow items not selling ranking" },
      { href: "/backoffice/insights/staff", label: "Staff performance", icon: UserRoundCheck, words: "servers waiters average check covers discounts refunds turn time" },
    ],
  },
  {
    id: "reports",
    title: "Reports",
    icon: BarChart3,
    links: [
      { href: "/backoffice/reports/sales", label: "Sales summary", icon: BarChart3, words: "revenue gross net totals payments" },
      { href: "/backoffice/reports/items", label: "Item sales", icon: ListOrdered, words: "products quantity sold categories" },
      { href: "/backoffice/reports/orders", label: "Order details", icon: ClipboardList, words: "tickets bills checks" },
      { href: "/backoffice/reports/tax", label: "Tax", icon: Percent, words: "vat report" },
      { href: "/backoffice/reports/day-close", label: "Day closing", icon: CalendarCheck, words: "z report end of day open day close day cash drawer count float shifts x report sales period" },
      { href: "/backoffice/reports/timecards", label: "Time cards", icon: Clock, words: "clock in out hours worked" },
      { href: "/backoffice/receipts", label: "Receipts", icon: Receipt, words: "refund reprint payment correction bills" },
    ],
  },
  {
    id: "menu",
    title: "Menu",
    retail: "Catalog",
    icon: UtensilsCrossed,
    links: [
      { href: "/backoffice/categories", label: "Categories", icon: Tags, words: "groups colours kitchen bar printer" },
      { href: "/backoffice/items", label: "Items", retail: "Products", icon: UtensilsCrossed, words: "products dishes prices barcode" },
      { href: "/backoffice/addons", label: "Add-ons", only: "restaurant", icon: SlidersHorizontal, words: "options modifiers extras" },
      { href: "/backoffice/taxes", label: "Taxes", icon: FileText, words: "vat zero rated exempt" },
      { href: "/backoffice/discounts", label: "Discounts", icon: BadgePercent, words: "promotions percent off" },
      { href: "/backoffice/suppliers", label: "Suppliers", only: "retail", icon: Truck, words: "vendors wholesalers contacts who we buy from" },
      { href: "/backoffice/stock", label: "Stock", icon: Boxes, words: "inventory quantity low" },
    ],
  },
  {
    id: "restaurant",
    title: "Restaurant",
    retail: "Shop",
    icon: Store,
    links: [
      { href: "/backoffice/tables", label: "Tables", only: "restaurant", icon: LayoutGrid, words: "floor plan rooms areas seats" },
      { href: "/backoffice/bookings", label: "Bookings", only: "restaurant", icon: CalendarClock, words: "reservations" },
      { href: "/backoffice/customers", label: "Customers", icon: Contact, words: "guests phone" },
      { href: "/backoffice/printers", label: "Printers", icon: Printer, words: "kitchen bar receipt ip usb" },
      { href: "/backoffice/receipt-design", label: "Receipt design", icon: ReceiptText, words: "logo header footer paper" },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    icon: Settings2,
    links: [
      { href: "/backoffice/settings", label: "POS settings", icon: Settings2, words: "payment types service charge order types lock takeaway" },
      { href: "/backoffice/company", label: "Company details", icon: Building2, words: "address brn vat number business" },
      { href: "/backoffice/staff", label: "Staff", icon: Users, words: "employees users pin logins" },
      { href: "/backoffice/roles", label: "Roles and permissions", icon: ShieldCheck, words: "access rights manager cashier" },
      { href: "/backoffice/data", label: "Backup and data", icon: Database, words: "export download delete transactions" },
    ],
  },
];

// A page is "on" for its own address and anything under it; the dashboard only for itself.
export const isOn = (href: string, path: string) => (href === HOME.href ? path === href : path === href || path.startsWith(href + "/"));
export const groupOf = (path: string) => GROUPS.find((g) => g.links.some((l) => isOn(l.href, path)))?.id ?? null;

// The groups one kind of business has, under the names it uses. The menu and
// the search both draw from this, so they cannot disagree about what exists.
export function groupsFor(mode: Mode): NavGroup[] {
  return GROUPS.map((g) => ({
    ...g,
    title: mode === "retail" && g.retail ? g.retail : g.title,
    links: g.links
      .filter((l) => !l.only || l.only === mode)
      .map((l) => (mode === "retail" && l.retail ? { ...l, label: l.retail } : l)),
  })).filter((g) => g.links.length > 0);
}

// Every page with the group it sits in, for the search.
export const pagesOf = (mode: Mode): (NavLink & { group: string | null })[] => [
  { ...HOME, group: null },
  ...groupsFor(mode).flatMap((g) => g.links.map((l) => ({ ...l, group: g.title }))),
];
