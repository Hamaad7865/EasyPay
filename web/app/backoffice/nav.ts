import {
  ArrowLeftRight,
  BadgePercent,
  BarChart3,
  Barcode,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ChartNoAxesCombined,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Contact,
  Database,
  FileText,
  FileUp,
  LayoutDashboard,
  LayoutGrid,
  QrCode,
  ListOrdered,
  type LucideIcon,
  PackageSearch,
  Percent,
  Printer,
  Receipt,
  ReceiptText,
  Settings,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TabletSmartphone,
  Tags,
  Ticket,
  TicketPercent,
  TrendingUp,
  Truck,
  UserRoundCheck,
  Users,
  UtensilsCrossed,
  Wallet, PackageCheck, BookUser, BookOpenText } from "lucide-react";
import type { Mode } from "@/lib/mode";

// Every page of the back office, once. The side menu draws its sections and
// groups from this list and the search finds pages in it, so the two cannot
// drift apart. Only what exists: a page is added here when it is built. `words`
// are other things someone might type when looking for the page.
// `only`: the one kind of business that has this page (none: both have it).
// `retail`: what a shop calls it, when that differs.
// `premium`: a page of the premium tier, which another plan does not have.
//
// The menu is in three sections under the day's page: Counter (what happens
// at the counter: orders, bookings, customers, the menu), Finance and stock
// (figures, money, stock) and Admin (people, set-up, tables, devices). In a
// section a line is either a page or a group that opens onto its pages. A
// group marked `flat` is one page and is drawn as that page's own line; so is
// a group left with one page for this business and plan.
export type NavLink = { href: string; label: string; icon: LucideIcon; words?: string; only?: Mode; retail?: string; premium?: true };
export type SectionId = "counter" | "money" | "admin";
export type NavGroup = { id: string; section: SectionId; title: string; icon: LucideIcon; links: NavLink[]; retail?: string; flat?: true };
export type NavSection = { id: SectionId; title: string; groups: NavGroup[] };
// The number beside a page in the menu, and what it counts, said in full (counts/route.ts).
export type NavCount = { n: number; say: string; tone?: "red" };

export const HOME: NavLink = { href: "/backoffice", label: "Today", icon: LayoutDashboard, words: "dashboard home overview right now" };

const SECTIONS: { id: SectionId; title: string }[] = [
  { id: "counter", title: "Counter" },
  { id: "money", title: "Finance and stock" },
  { id: "admin", title: "Admin" },
];

export const GROUPS: NavGroup[] = [
  // ---- Counter ----
  {
    id: "orders",
    section: "counter",
    title: "Orders",
    icon: ClipboardList,
    flat: true,
    links: [{ href: "/backoffice/reports/orders", label: "Orders", icon: ClipboardList, words: "order details tickets bills checks reports open closed" }],
  },
  {
    id: "bookings",
    section: "counter",
    title: "Bookings",
    icon: CalendarClock,
    flat: true,
    links: [{ href: "/backoffice/bookings", label: "Bookings", only: "restaurant", premium: true, icon: CalendarClock, words: "reservations" }],
  },
  {
    id: "customers",
    section: "counter",
    title: "Customers",
    icon: Contact,
    flat: true,
    links: [{ href: "/backoffice/customers", label: "Customers", icon: Contact, words: "guests phone" }],
  },
  {
    id: "menu",
    section: "counter",
    title: "Menu",
    retail: "Catalog",
    icon: UtensilsCrossed,
    links: [
      { href: "/backoffice/categories", label: "Categories", icon: Tags, words: "groups colours kitchen bar printer" },
      { href: "/backoffice/items", label: "Items", retail: "Products", icon: UtensilsCrossed, words: "products dishes prices barcode" },
      { href: "/backoffice/items/import", label: "Import products", only: "retail", icon: FileUp, words: "excel xlsx csv spreadsheet upload supplier file bulk add many catalog" },
      { href: "/backoffice/items/labels", label: "Barcode labels", only: "retail", icon: Barcode, words: "print stickers price tags ean scan label roll a4 sheet" },
      { href: "/backoffice/addons", label: "Add-ons", only: "restaurant", icon: SlidersHorizontal, words: "options modifiers extras" },
      { href: "/backoffice/discounts", label: "Discounts", icon: BadgePercent, words: "percent off" },
      { href: "/backoffice/promotions", label: "Promotions", only: "retail", icon: TicketPercent, words: "slow movers markdown sale price lift reduce clearance" },
    ],
  },
  // ---- Finance and stock ----
  {
    id: "insights",
    section: "money",
    title: "Insights",
    icon: ChartNoAxesCombined,
    links: [
      { href: "/backoffice/insights/sales", label: "Sales patterns", icon: CalendarRange, words: "busiest day hour peak heatmap trend compare average check" },
      { href: "/backoffice/insights/menu", label: "Menu performance", retail: "Product performance", icon: TrendingUp, words: "best sellers popular slow items not selling ranking" },
      { href: "/backoffice/insights/staff", label: "Staff performance", icon: UserRoundCheck, words: "servers waiters average check covers discounts refunds turn time team" },
    ],
  },
  {
    id: "finance",
    section: "money",
    title: "Finance",
    icon: Wallet,
    links: [
      { href: "/backoffice/reports/sales", label: "Sales summary", icon: BarChart3, words: "reports overview revenue gross net totals payments takings" },
      { href: "/backoffice/reports/journal", label: "Sales journal", icon: BookOpenText, words: "journal de ventes cash basis takings money received period compare taxes vat categories payments methods users accountant" },
      { href: "/backoffice/reports/items", label: "Item sales", icon: ListOrdered, words: "reports products quantity sold categories cost profit margin" },
      { href: "/backoffice/reports/stock", label: "Stock reports", only: "retail", icon: PackageSearch, words: "stock value worth inventory valuation reorder list low to order losses damaged expired lost stolen shrinkage written off not selling slow dead stock" },
      { href: "/backoffice/receipts", label: "Receipts", icon: Receipt, words: "refund reprint payment correction bills paid orders" },
      { href: "/backoffice/credit-notes", label: "Credit notes", only: "retail", icon: Ticket, words: "return exchange slip balance voucher cancel void" },
      { href: "/backoffice/deposits", label: "Deposits", only: "retail", icon: PackageCheck, words: "layaway lay-by layby reserve hold held put aside part payment collect overdue" },
      { href: "/backoffice/accounts", label: "Accounts", only: "retail", icon: BookUser, words: "customer accounts on account credit owe owed debt debtors receivables reconciliation statement aged balance overdue pay later" },
      { href: "/backoffice/reports/day-close", label: "Day closing", icon: CalendarCheck, words: "reports z report end of day open day close day cash drawer count float shifts x report sales period till counts" },
      { href: "/backoffice/reports/tax", label: "Tax", icon: Percent, words: "reports vat report returns" },
    ],
  },
  // A restaurant's stock is one page, a shop's is five: each kind of business
  // gets its own page at the first address.
  {
    id: "stock",
    section: "money",
    title: "Stock",
    icon: Boxes,
    links: [
      { href: "/backoffice/stock", label: "Stock", only: "restaurant", icon: Boxes, words: "inventory quantity low" },
      { href: "/backoffice/stock", label: "Stock on hand", only: "retail", icon: Boxes, words: "inventory quantity low out below zero value reorder adjust damaged expired lost found" },
      { href: "/backoffice/purchase-orders", label: "Purchase orders", only: "retail", icon: ClipboardList, words: "buy order supplier receive delivery arrived invoice po" },
      { href: "/backoffice/suppliers", label: "Suppliers", only: "retail", icon: Truck, words: "vendors wholesalers contacts who we buy from" },
      { href: "/backoffice/stock-counts", label: "Counts", only: "retail", icon: ClipboardCheck, words: "stocktake stock take count inventory audit shelves scan difference variance" },
      { href: "/backoffice/stock-movements", label: "Movements", only: "retail", icon: ArrowLeftRight, words: "history log stock in out sold received adjusted counted" },
    ],
  },
  // ---- Admin ----
  {
    id: "team",
    section: "admin",
    title: "Team",
    icon: Users,
    links: [
      { href: "/backoffice/staff", label: "Staff", icon: Users, words: "people employees users pin logins" },
      { href: "/backoffice/roles", label: "Roles and permissions", icon: ShieldCheck, words: "access rights manager cashier security" },
      { href: "/backoffice/reports/timecards", label: "Time cards", icon: Clock, words: "reports time clock in out hours worked" },
    ],
  },
  {
    id: "setup",
    section: "admin",
    title: "Setup",
    icon: Settings,
    links: [
      { href: "/backoffice/settings", label: "POS settings", icon: Settings2, words: "settings payment types service charge order types lock takeaway" },
      { href: "/backoffice/company", label: "Company details", icon: Building2, words: "settings address brn vat number business" },
      { href: "/backoffice/taxes", label: "Taxes", icon: FileText, words: "vat zero rated exempt tax and charges" },
      { href: "/backoffice/receipt-design", label: "Receipt design", icon: ReceiptText, words: "logo header footer paper" },
      { href: "/backoffice/data", label: "Backup and data", icon: Database, words: "settings export download delete transactions" },
    ],
  },
  {
    id: "tables",
    section: "admin",
    title: "Tables and QR codes",
    icon: QrCode,
    links: [
      { href: "/backoffice/tables", label: "Floor plan", only: "restaurant", icon: LayoutGrid, words: "tables rooms areas seats designer walls booths" },
      { href: "/backoffice/tables/cards", label: "Table cards", only: "restaurant", premium: true, icon: QrCode, words: "qr code scan order from the table menu phone guests print" },
    ],
  },
  {
    id: "devices",
    section: "admin",
    title: "Devices and printers",
    icon: TabletSmartphone,
    links: [
      // one page of till cards; each till's own page has its activity (Traceability) and its cash flow
      {
        href: "/backoffice/pos",
        label: "Tills",
        icon: TabletSmartphone,
        words:
          "point of sale pos devices tablets terminals connected online offline last sync version rename deactivate till activity traceability log history events what happened late crash cash flow drawer cash in out float ledger balance movements money cash-ups variance",
      },
      { href: "/backoffice/printers", label: "Printers", icon: Printer, words: "kitchen bar receipt ip usb stations" },
    ],
  },
];

// A page is "on" for its own address and anything under it; the dashboard only for itself.
// A line of the menu is lit when the address is its page or a page under it,
// unless another line's page is nearer: Barcode labels sits under Products,
// and on it only Barcode labels is lit.
const under = (href: string, path: string) => path === href || path.startsWith(href + "/");
export const isOn = (href: string, path: string) =>
  href === HOME.href
    ? path === href
    : under(href, path) && !GROUPS.some((g) => g.links.some((l) => l.href.length > href.length && under(l.href, path)));
// The group a page sits in, for this kind of business: one address can be in
// two groups (Stock), one for each kind.
export const groupOf = (path: string, mode: Mode, premium: boolean) =>
  groupsFor(mode, premium).find((g) => g.links.some((l) => isOn(l.href, path)))?.id ?? null;

// The groups one kind of business has on its plan, under the names it uses.
// The menu and the search both draw from this, so they cannot disagree about
// what exists. A group left with one page is drawn as that page (`flat`), under
// the page's own name.
export function groupsFor(mode: Mode, premium: boolean): NavGroup[] {
  return GROUPS.map((g) => {
    const links = g.links
      .filter((l) => (!l.only || l.only === mode) && (!l.premium || premium))
      .map((l) => (mode === "retail" && l.retail ? { ...l, label: l.retail } : l));
    const flat = g.flat || links.length === 1 ? (true as const) : undefined;
    return {
      ...g,
      flat,
      title: flat && links[0] ? links[0].label : mode === "retail" && g.retail ? g.retail : g.title,
      icon: flat && !g.flat && links[0] ? links[0].icon : g.icon,
      links,
    };
  }).filter((g) => g.links.length > 0);
}

// The menu's sections, each with the groups this business has in it.
export function sectionsFor(mode: Mode, premium: boolean): NavSection[] {
  const groups = groupsFor(mode, premium);
  return SECTIONS.map((s) => ({ ...s, groups: groups.filter((g) => g.section === s.id) })).filter((s) => s.groups.length > 0);
}

// What a page's heading has above it: the group it sits in, where that is not
// the page itself. Null on the day's page and on a page that is its own line.
export function over(path: string, mode: Mode, premium: boolean): string | null {
  const g = groupsFor(mode, premium).find((x) => x.links.some((l) => isOn(l.href, path)));
  return g && !g.flat ? g.title : null;
}

// Every page with the group it sits in, for the search.
export const pagesOf = (mode: Mode, premium: boolean): (NavLink & { group: string | null })[] => [
  { ...HOME, group: null },
  ...groupsFor(mode, premium).flatMap((g) => g.links.map((l) => ({ ...l, group: g.flat ? SECTIONS.find((x) => x.id === g.section)!.title : g.title }))),
];
