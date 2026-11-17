"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight, Bell, Building2, CheckCheck, ChevronRight, ClipboardCheck, Compass, Contact, FileText, LogOut, Menu, Plus, Search, ShoppingBag,
  Truck, UtensilsCrossed, type LucideIcon,
  // the tour's pictures
  Activity, AlertTriangle, CalendarRange, Clock, LayoutGrid, LineChart, Package, Percent, Receipt, Sparkles, Tablet, TrendingUp, Users, Wallet,
} from "lucide-react";
import { HOME, isOn, pagesOf } from "../nav";
import { openSearch, useSearchKey } from "../search-box";
import { Submit } from "../busy";
import { Line, Pop } from "./pop";
import { ProductTour, type TourStep } from "./tour";
import type { Mode } from "@/lib/mode";
import type { Alert } from "../alerts/route";

// The bar across the top of every back office page, at every width.
//
//   - on a phone or a narrow tablet: the menu's key and whose back office this
//     is (the menu itself is a panel there, side.tsx);
//   - on a wide window: where the page is (after EasyUI's Breadcrumb: Today,
//     the group, the page, a pill gliding under the one pointed at);
//   - the search, as a field (after EasyUI's iOS search bar): it opens the
//     search of side.tsx, Ctrl K as before;
//   - New: the things an owner starts most, each on the page where it is done;
//   - the tour (after EasyUI's Product Tour), offered once to a new owner on
//     the day's page, and again from its key any time;
//   - the bell (after EasyUI's Notification Bell): what needs a look, from
//     alerts/route.ts, a dot on those not seen yet in this browser;
//   - who is signed in, with the way out.

const MENU = "easypay:menu";
export const openMenu = () => window.dispatchEvent(new Event(MENU));
export const onOpenMenu = (fn: () => void) => {
  window.addEventListener(MENU, fn);
  return () => window.removeEventListener(MENU, fn);
};

const YEAR = 60 * 60 * 24 * 365;
const SEEN = "easypay:alerts-seen";

const initials = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? "?").slice(0, 2)).toUpperCase();
};

// what New offers, each only where the business has that page
const STARTS: { href: string; page: string; label: string; retail?: string; icon: LucideIcon; retailIcon?: LucideIcon; say: string }[] = [
  { href: "/backoffice/items?edit=new", page: "/backoffice/items", label: "Add an item", retail: "Add a product", icon: UtensilsCrossed, retailIcon: ShoppingBag, say: "Its price, tax and category" },
  { href: "/backoffice/invoices", page: "/backoffice/invoices", label: "Start an invoice", icon: FileText, say: "For a customer, to print or send" },
  { href: "/backoffice/customers", page: "/backoffice/customers", label: "Add a customer", icon: Contact, say: "Name, phone, what they owe" },
  { href: "/backoffice/purchase-orders", page: "/backoffice/purchase-orders", label: "Order from a supplier", icon: Truck, say: "A purchase order, received into stock" },
  { href: "/backoffice/stock-counts", page: "/backoffice/stock-counts", label: "Count the stock", icon: ClipboardCheck, say: "What is on the shelf, against the books" },
];

function readSeen(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? "[]");
  } catch {
    return [];
  }
}
function keepSeen(ids: string[]) {
  try {
    localStorage.setItem(SEEN, JSON.stringify(ids.slice(-60)));
  } catch {
    // a private window: the dots come back next time, nothing else is lost
  }
}

export function TopBar({
  mode, premium, mra, many, restaurant, id, employee, role, signOut, tourDue, drawn,
}: {
  mode: Mode; premium: boolean; mra: boolean; many: boolean;
  restaurant: string; id: string; employee: string | null; role: string | null;
  signOut: () => Promise<void>;
  // a new owner who has not seen the tour in this browser: it starts by itself on the day's page
  tourDue: boolean;
  // when the server last drew the shell: the bell asks again after a save
  drawn: number;
}) {
  const path = usePathname();
  const reduce = useReducedMotion();
  const key = useSearchKey();
  const shop = mode === "retail";
  const pages = useMemo(() => pagesOf(mode, premium, mra, many), [mode, premium, mra, many]);

  // where the page is: Today, then its group, then the page (the nearest page that is "on")
  const here = useMemo(() => {
    const p = pages.filter((x) => x.href !== HOME.href && isOn(x.href, path)).sort((a, b) => b.href.length - a.href.length)[0];
    return p ?? null;
  }, [pages, path]);
  const crumbs = [
    { label: HOME.label, href: HOME.href },
    ...(here?.group ? [{ label: here.group, href: null as string | null }] : []),
    ...(here ? [{ label: here.label, href: here.href }] : []),
  ];
  const [glide, setGlide] = useState<number | null>(null);

  const starts = STARTS.filter((s) => pages.some((p) => p.href === s.page));

  // ---- the bell ----
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  // no answer (signed out, no connection): the bell says so rather than that all is well
  const [lost, setLost] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  const [shake, setShake] = useState(false);
  useEffect(() => setSeen(readSeen()), []);
  const asked = useRef(0);
  const ask = useCallback(() => {
    const mine = ++asked.current;
    fetch("/backoffice/alerts", { cache: "no-store" })
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .then((d: { alerts?: Alert[] } | null) => {
        if (mine !== asked.current) return;
        if (d?.alerts) setAlerts(d.alerts);
        setLost(!d?.alerts);
      })
      .catch(() => mine === asked.current && setLost(true));
  }, []);
  useEffect(() => ask(), [path, drawn, ask]);
  const fresh = (alerts ?? []).filter((a) => !seen.includes(a.id));
  const before = useRef(0);
  useEffect(() => {
    if (fresh.length > before.current && before.current >= 0 && !reduce) {
      setShake(true);
      const t = setTimeout(() => setShake(false), 600);
      before.current = fresh.length;
      return () => clearTimeout(t);
    }
    before.current = fresh.length;
  }, [fresh.length, reduce]);
  const markAll = () => {
    const next = [...new Set([...seen, ...(alerts ?? []).map((a) => a.id)])];
    setSeen(next);
    keepSeen(next);
  };
  const markOne = (id: string) => {
    if (seen.includes(id)) return;
    const next = [...seen, id];
    setSeen(next);
    keepSeen(next);
  };

  // ---- the tour ----
  const [touring, setTouring] = useState(false);
  const [steps, setSteps] = useState<TourStep[]>([]);
  const all = useMemo<TourStep[]>(() => {
    const first = employee?.trim().split(/\s+/)[0];
    return [
      { section: "Welcome", art: { icon: Sparkles, bits: [Receipt, Package, Users] }, title: `Welcome to EasyPay${first ? ", " + first : ""}`, body: `This is your back office: everything your ${shop ? "shop's tills" : "restaurant's tablets"} sell lands here. A minute to show you round. Next and Back move along, the arrow keys too, and Esc stops.` },
      { target: "#bo-menu .bo-nav, .rail[data-folded], [data-tour='menu-key']", section: "Menu", art: { icon: LayoutGrid, bits: [ShoppingBag, Wallet, Building2] }, title: "Every page, grouped", body: `Today, then three sections: the counter (sales, customers, the ${shop ? "catalog" : "menu"}), money and stock, and your set-up. A group opens onto its pages.`, placement: "right" },
      { target: "[data-tour='search']", section: "Search", art: { icon: Search, bits: [FileText, Package, Contact] }, title: "Find anything", body: `A page, ${shop ? "a product, a category or a customer" : "an item, a category, a customer or a table"}: type a few letters. ${key} opens it from anywhere.`, placement: "bottom" },
      { target: "[data-tour='new']", section: "New", art: { icon: Plus, bits: [FileText, Contact, Truck] }, title: "Start something new", body: `${shop ? "A product" : "An item"}, an invoice, a customer, an order to a supplier or a stock count, from any page.`, placement: "bottom" },
      { target: "[data-tour='bell']", section: "Alerts", art: { icon: Bell, bits: [Receipt, AlertTriangle, Package] }, title: "What needs a look", body: "Receipts a till flagged, overdue invoices, stock running low and the rest. A dot means something new since you last looked.", placement: "bottom" },
      { target: "[data-tour='attention']", section: "Today", art: { icon: AlertTriangle, bits: [Package, FileText, Percent] }, title: "Needs attention", body: "The same things on the day's page, the most pressing first, each with the page where it is put right.", placement: "bottom" },
      { target: "[data-tour='now']", section: "Today", art: { icon: Tablet, bits: [Receipt, Clock, Activity] }, title: "Right now", body: `What is open on the ${shop ? "tills" : "tablets"} this minute, and whether the day is open.`, placement: "left" },
      { target: "[data-tour='days']", section: "Sales", art: { icon: CalendarRange, bits: [Clock, CalendarRange, TrendingUp] }, title: "Pick the days", body: "Every figure below is for the days picked here: a quick choice, or any range on the calendar. Compare puts the days before beside them.", placement: "bottom" },
      { target: "[data-tour='stats']", section: "Sales", art: { icon: TrendingUp, bits: [Wallet, Percent, Receipt] }, title: "The figures", body: "Gross and net sales, VAT, how many sales and their average. Run a finger along a small curve to see each day.", placement: "top" },
      { target: "[data-tour='chart']", section: "Sales", art: { icon: LineChart, bits: [Activity, CalendarRange, TrendingUp] }, title: "Day by day", body: "Point at a day to read it. With Compare on, the dashed line is the days before.", placement: "top" },
      { target: "[data-tour='tour']", section: "Done", art: { icon: Compass, bits: [CheckCheck, Tablet, Sparkles] }, title: "That's the tour", body: "Take it again any time from here. Your tills are set up from Devices and printers in the menu.", placement: "bottom" },
    ];
  }, [employee, shop, key]);
  const startTour = useCallback(() => {
    // only the parts that are on this page, as it is drawn now (the menu folded or open, a phone or a wide window)
    const on = (sel?: string) => !sel || Array.from(document.querySelectorAll<HTMLElement>(sel)).some((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
    setSteps(all.filter((s) => on(s.target)));
    setTouring(true);
  }, [all]);
  const endTour = () => {
    setTouring(false);
    document.cookie = `bo-tour=seen; path=/; max-age=${YEAR}; samesite=lax`;
  };
  // a new owner: once, on the day's page, when it has settled
  const started = useRef(false);
  useEffect(() => {
    if (!tourDue || started.current || path !== HOME.href) return;
    started.current = true;
    const t = setTimeout(startTour, 900);
    return () => clearTimeout(t);
  }, [tourDue, path, startTour]);

  return (
    <header className="bo-top no-print">
      <button type="button" className="bo-top-key bo-top-narrow" data-tour="menu-key" aria-label="Open the menu" aria-controls="bo-menu" onClick={openMenu}>
        <Menu aria-hidden="true" strokeWidth={1.9} />
      </button>
      <Link href={HOME.href} className="bo-top-name bo-top-narrow" title={restaurant}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" />
        <b>{restaurant}</b>
      </Link>

      <nav className="eu-crumbs" aria-label="Where you are" onPointerLeave={() => setGlide(null)}>
        <ol>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={i} onPointerEnter={() => setGlide(i)}>
                {i > 0 && <ChevronRight aria-hidden="true" className="eu-crumb-sep" />}
                <span className="eu-crumb">
                  {glide === i && !last && c.href && <motion.span layoutId="eu-crumb-pill" className="eu-crumb-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                  {c.href && !last ? <Link href={c.href}>{c.label}</Link> : <span aria-current={last ? "page" : undefined} className={last ? "now" : undefined}>{c.label}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      <button type="button" className="eu-search" data-tour="search" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" onClick={openSearch}>
        <Search aria-hidden="true" strokeWidth={2} />
        <span>{shop ? "Search pages, products, customers…" : "Search pages, items, customers, tables…"}</span>
        <kbd>{key}</kbd>
      </button>

      <div className="eu-top-keys">
        <Pop
          label="Start something new"
          wide
          trigger={(open, toggle, ref) => (
            <button ref={ref} type="button" className="eu-new" data-tour="new" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
              <motion.span animate={{ rotate: open ? 45 : 0 }} transition={{ type: "spring", stiffness: 420, damping: 24 }} style={{ display: "grid" }}>
                <Plus aria-hidden="true" strokeWidth={2.2} />
              </motion.span>
              <span>New</span>
            </button>
          )}
        >
          {(close) => (
            <div className="eu-menu">
              {starts.map((s) => {
                const Icon = shop && s.retailIcon ? s.retailIcon : s.icon;
                return (
                  <Line key={s.href}>
                    <Link href={s.href} className="eu-menu-row" onClick={close}>
                      <span className="eu-menu-ico"><Icon aria-hidden="true" strokeWidth={1.9} /></span>
                      <span className="eu-menu-text">
                        <b>{shop && s.retail ? s.retail : s.label}</b>
                        <small>{s.say}</small>
                      </span>
                    </Link>
                  </Line>
                );
              })}
            </div>
          )}
        </Pop>

        <button type="button" className="eu-icon-key" data-tour="tour" aria-label="Take the tour" title="Take the tour" onClick={startTour}>
          <Compass aria-hidden="true" strokeWidth={1.9} />
        </button>

        <Pop
          label="What needs a look"
          wide
          trigger={(open, toggle, ref) => (
            <motion.button
              ref={ref}
              type="button"
              className={"eu-icon-key" + (open ? " on" : "")}
              data-tour="bell"
              aria-expanded={open}
              aria-haspopup="dialog"
              aria-label={fresh.length > 0 ? `${fresh.length} new to look at` : "What needs a look"}
              title="What needs a look"
              onClick={toggle}
              animate={shake ? { rotate: [0, -12, 10, -8, 6, -2, 0] } : { rotate: 0 }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
            >
              <Bell aria-hidden="true" strokeWidth={1.9} />
              <AnimatePresence>
                {fresh.length > 0 && (
                  <motion.span className="eu-bell-n" initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 30, mass: 0.5 }}>
                    {fresh.length > 9 ? "9+" : fresh.length}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          )}
        >
          {(close) => (
            <div className="eu-bell">
              <div className="eu-bell-head">
                <b>Needs a look</b>
                {fresh.length > 0 && <span className="eu-bell-new">{fresh.length} new</span>}
                <span className="spacer" />
                {fresh.length > 0 && (
                  <button type="button" onClick={markAll} title="Mark them all as seen">
                    <CheckCheck aria-hidden="true" />
                    Seen all
                  </button>
                )}
              </div>
              <div className="eu-bell-list">
                {alerts === null ? (
                  <p className="eu-bell-none">{lost ? "EasyPay could not be reached just now. Open the bell again in a moment." : "Looking…"}</p>
                ) : alerts.length === 0 ? (
                  <div className="eu-bell-none">
                    <Bell aria-hidden="true" />
                    <p>Nothing needs a look. Everything is on track.</p>
                  </div>
                ) : (
                  alerts.map((a) => {
                    const isNew = !seen.includes(a.id);
                    return (
                      <Line key={a.id}>
                        <Link
                          href={a.href}
                          className={"eu-bell-row" + (isNew ? " new" : "")}
                          onClick={() => {
                            markOne(a.id);
                            close();
                          }}
                        >
                          <i className={"eu-bell-dot " + a.tone + (isNew ? " live" : "")} aria-hidden />
                          <span className="eu-bell-text">
                            <b>{a.title}</b>
                            <small>{a.text}</small>
                            <em>
                              {a.go}
                              <ArrowRight aria-hidden="true" />
                            </em>
                          </span>
                        </Link>
                      </Line>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </Pop>

        <Pop
          label="Your account"
          trigger={(open, toggle, ref) => (
            <button ref={ref} type="button" className="eu-me" aria-expanded={open} aria-haspopup="dialog" aria-label={`${employee ?? "Signed in"}: account`} onClick={toggle}>
              <span className="bo-tile" aria-hidden="true">{initials(employee ?? "?")}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="eu-menu">
              <Line className="eu-me-head">
                <span className="bo-tile" aria-hidden="true">{initials(employee ?? "?")}</span>
                <span>
                  <b>{employee ?? "Signed in"}</b>
                  {role && <small>{role}</small>}
                </span>
              </Line>
              <Line>
                <Link href="/backoffice/company" className="eu-menu-row" onClick={close}>
                  <span className="eu-menu-ico"><Building2 aria-hidden="true" strokeWidth={1.9} /></span>
                  <span className="eu-menu-text">
                    <b>{restaurant}</b>
                    <small>ID {id} · company details</small>
                  </span>
                </Link>
              </Line>
              <Line>
                <button type="button" className="eu-menu-row" onClick={() => { close(); startTour(); }}>
                  <span className="eu-menu-ico"><Compass aria-hidden="true" strokeWidth={1.9} /></span>
                  <span className="eu-menu-text"><b>Take the tour</b><small>A minute round the back office</small></span>
                </button>
              </Line>
              <Line>
                <form action={signOut}>
                  <Submit className="eu-menu-row out">
                    <span className="eu-menu-ico"><LogOut aria-hidden="true" strokeWidth={1.9} /></span>
                    <span className="eu-menu-text"><b>Sign out</b></span>
                  </Submit>
                </form>
              </Line>
            </div>
          )}
        </Pop>
      </div>

      <ProductTour steps={steps} open={touring} onClose={endTour} />
    </header>
  );
}
