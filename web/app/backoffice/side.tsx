"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, PanelLeftClose, PanelLeftOpen, Search, Store } from "lucide-react";
import { GROUPS, HOME, groupOf, isOn, type NavCount } from "./nav";
import { openSearch, SearchBox, useSearchKey } from "./search-box";

// The way round the back office, in two parts.
//
// The rail: a column of round signs down the far left, one for the dashboard
// and one for each group of pages, with who is signed in and the switch that
// folds the menu away at the bottom.
//
// The menu: a pane of frosted glass beside it with the restaurant, the search
// and every page under its group. A group opens to show its pages (they drop
// in one after the other); as many can be open at once as someone likes.
//
// Folded away, the menu leaves the rail: a sign then opens its group's pages
// in a small card beside it, so every page is still two taps off and the page
// has the whole width. Which way it was left, and which groups were open, is
// remembered in this browser (two cookies, read before the page is drawn so
// it never opens one way and jumps to the other).

const YEAR = 60 * 60 * 24 * 365;
const remember = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/; max-age=${YEAR}; samesite=lax`;
};

// A card beside the rail is put level with the sign that opened it, before it shows.
function place(sign: HTMLElement, cardId: string, fromBottom = false) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const r = sign.getBoundingClientRect();
  card.style.left = `${Math.round(r.right + 12)}px`;
  if (fromBottom) {
    card.style.top = "auto";
    card.style.bottom = `${Math.round(window.innerHeight - r.bottom)}px`;
    return;
  }
  card.style.bottom = "auto";
  card.style.top = `${Math.round(Math.max(12, r.top - 8))}px`;
  // a long list low on the rail is moved up to stay on the screen
  requestAnimationFrame(() => {
    const box = card.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 12) card.style.top = `${Math.round(Math.max(12, window.innerHeight - 12 - box.height))}px`;
  });
}
const shut = () => document.querySelectorAll<HTMLElement>(".rail-card:popover-open").forEach((c) => c.hidePopover());

// The number beside a page: how many rows its list holds. Past 999 it is
// shortened (1.2k), and its title says the whole of it.
function Count({ c }: { c: NavCount | undefined }) {
  if (!c) return null;
  const short = c.n > 999 ? `${c.n >= 9950 ? Math.round(c.n / 1000) : Math.round(c.n / 100) / 10}k` : String(c.n);
  return (
    <span className={"nav-n" + (c.tone ? " " + c.tone : "") + (c.n === 0 ? " zero" : "")} title={c.say} aria-label={c.say}>
      {short}
    </span>
  );
}

export function Side({
  restaurant, id, employee, role, signOut, folded, opened, drawn,
}: {
  restaurant: string;
  // the start of the restaurant's id: what to quote to EasyPay support
  id: string;
  employee: string | null;
  role: string | null;
  signOut: () => Promise<void>;
  // how the menu was left in this browser: folded away or not, and the groups
  // that were open (null when it has never been touched)
  folded: boolean;
  opened: string[] | null;
  // when the server last drew the shell. Going from page to page leaves it
  // alone; a save draws it again, and the numbers in the menu are asked for
  // again then, whatever the save's "saved" line says.
  drawn: number;
}) {
  const path = usePathname();
  const here = groupOf(path);
  const key = useSearchKey();
  const [away, setAway] = useState(folded);
  // The group holding the page that is open is open, on the server and in the
  // browser alike, with whichever others were left open; arriving on a page
  // of another group opens that one too and closes nothing.
  const [open, setOpen] = useState<Set<string>>(() => new Set([...(opened ?? []), ...(here ? [here] : [])]));
  const [seen, setSeen] = useState(path);
  if (seen !== path) {
    setSeen(path);
    if (here && !open.has(here)) setOpen(new Set([...open, here]));
  }
  // The settling bounce is for the group someone has just opened: not for the
  // page loading, and not for the groups that were open already.
  const [fresh, setFresh] = useState<string | null>(null);

  // On a narrow screen there is no rail and the menu is never folded away,
  // whatever was chosen on a wide one.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 1000px)");
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  // The list scrolls without a bar, so the page that is open is brought into
  // view once its group has finished opening; and a card beside the rail is
  // shut on arriving anywhere.
  // The numbers beside the pages. They are asked for once a page is on the
  // screen, so no page waits for them; an answer to an older question, or one
  // that is not what was asked for (signed out, no connection), is dropped.
  const [counts, setCounts] = useState<Record<string, NavCount>>({});
  const asked = useRef(0);
  const last = useRef(0);
  const count = useCallback(() => {
    // asked twice at once is asked once (a save that lands on another page;
    // React starting everything twice while developing)
    if (Date.now() - last.current < 250) return;
    last.current = Date.now();
    const mine = ++asked.current;
    fetch("/backoffice/counts", { cache: "no-store" })
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .then((d: { counts?: Record<string, NavCount> } | null) => {
        if (d?.counts && mine === asked.current) setCounts(d.counts);
      })
      .catch(() => {});
  }, []);
  useEffect(() => count(), [path, drawn, count]);

  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    shut();
    const t = setTimeout(() => nav.current?.querySelector("a.on")?.scrollIntoView({ block: "nearest" }), 380);
    return () => clearTimeout(t);
  }, [path]);

  const keep = (next: Set<string>) => {
    setOpen(next);
    remember("bo-groups", [...next].join("."));
  };
  const toggle = (g: string) => {
    const next = new Set(open);
    if (next.delete(g)) setFresh(null);
    else {
      next.add(g);
      setFresh(g);
    }
    keep(next);
  };
  // from the rail, with the menu showing: that group is opened and brought into view
  const reveal = (g: string) => {
    if (!open.has(g)) {
      setFresh(g);
      keep(new Set([...open, g]));
    }
    setTimeout(() => document.getElementById(`nav-head-${g}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 80);
  };
  const fold = () => {
    shut();
    remember("bo-menu", away ? "open" : "closed");
    setAway(!away);
  };
  const initial = (employee ?? "?").trim().slice(0, 1).toUpperCase();
  const leave = (
    <form action={signOut}>
      <button type="submit" title="Sign out" aria-label="Sign out">
        <LogOut aria-hidden="true" />
      </button>
    </form>
  );

  return (
    <>
      {/* while developing, Next.js puts its own round badge in the bottom left corner: the rail stops short of it */}
      <nav className={"rail" + (process.env.NODE_ENV === "development" ? " dev" : "")} aria-label="Sections" data-folded={away || undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <span className="rail-logo"><img src="/logo-mark.png" alt="EasyPay" /></span>
        <Link href={HOME.href} className={"rail-sign" + (isOn(HOME.href, path) ? " on" : "")} aria-label={HOME.label} data-tip={HOME.label}>
          <HOME.icon aria-hidden="true" strokeWidth={1.9} />
        </Link>
        {GROUPS.map((g) => (
          <div key={g.id} className="rail-item">
            <button
              type="button"
              className={"rail-sign" + (here === g.id ? " on" : "")}
              aria-label={g.title}
              data-tip={g.title}
              // folded away, the sign opens its pages beside it; otherwise it opens its group in the menu
              popoverTarget={away ? `rail-${g.id}` : undefined}
              onClick={(e) => (away ? place(e.currentTarget, `rail-${g.id}`) : reveal(g.id))}
            >
              <g.icon aria-hidden="true" strokeWidth={1.9} />
            </button>
            <div id={`rail-${g.id}`} popover="auto" className="rail-card">
              <b>{g.title}</b>
              {g.links.map((l, i) => (
                <Link key={l.href} href={l.href} className={isOn(l.href, path) ? "on" : undefined} style={{ "--i": i } as React.CSSProperties} onClick={shut}>
                  <l.icon aria-hidden="true" strokeWidth={1.9} />
                  {l.label}
                  <Count c={counts[l.href]} />
                </Link>
              ))}
            </div>
          </div>
        ))}
        <span className="rail-gap" />
        <button type="button" className="rail-sign rail-when-folded" aria-label="Search" data-tip={`Search (${key})`} onClick={openSearch}>
          <Search aria-hidden="true" strokeWidth={1.9} />
        </button>
        <div className="rail-item">
          <button type="button" className="rail-sign rail-me" aria-label={`${employee ?? "Signed in"}: account`} data-tip={employee ?? "Signed in"} popoverTarget="rail-me" onClick={(e) => place(e.currentTarget, "rail-me", true)}>
            {initial}
          </button>
          <div id="rail-me" popover="auto" className="rail-card rail-who">
            <span className="bo-avatar" aria-hidden="true">{initial}</span>
            <span>
              <b>{employee ?? "Signed in"}</b>
              {role && <small>{role}</small>}
            </span>
            {leave}
          </div>
        </div>
        <button type="button" className="rail-sign" aria-label={away ? "Show the menu" : "Fold the menu away"} aria-expanded={!away} aria-controls="bo-menu" data-tip="Show the menu" onClick={fold}>
          {away ? <PanelLeftOpen aria-hidden="true" strokeWidth={1.9} /> : <PanelLeftClose aria-hidden="true" strokeWidth={1.9} />}
        </button>
      </nav>

      {/* folded away, its links are out of reach of the Tab key too */}
      <aside className="bo-side" id="bo-menu" data-folded={away || undefined} inert={away && !narrow}>
        <div className="bo-side-in">
          <div className="bo-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.png" alt="" className="bo-brand-logo" />
            <span>
              Easy<span className="bo-brand-pos">Pay</span>
            </span>
          </div>
          <div className="bo-restaurant" title={restaurant}>
            <Store aria-hidden="true" />
            <span>
              <b>{restaurant}</b>
              <small>ID {id}</small>
            </span>
          </div>
          <button type="button" className="search-trigger" onClick={openSearch} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">
            <Search aria-hidden="true" />
            <span>Search</span>
            <kbd>{key}</kbd>
          </button>
          <nav className="bo-nav" ref={nav} aria-label="Back office">
            <Link href={HOME.href} className={"bo-nav-top" + (isOn(HOME.href, path) ? " on" : "")}>
              <HOME.icon aria-hidden="true" strokeWidth={1.9} />
              {HOME.label}
            </Link>
            {GROUPS.map((g) => {
              const isOpen = open.has(g.id);
              return (
                <div key={g.id} className={"bo-group" + (isOpen ? " open" : "") + (here === g.id ? " here" : "")} data-fresh={fresh === g.id || undefined}>
                  <button type="button" id={`nav-head-${g.id}`} className="bo-group-head" aria-expanded={isOpen} aria-controls={`nav-${g.id}`} onClick={() => toggle(g.id)}>
                    <g.icon aria-hidden="true" strokeWidth={1.9} />
                    <span>{g.title}</span>
                    <ChevronDown aria-hidden="true" className="bo-group-chev" strokeWidth={2.2} />
                  </button>
                  {/* a closed group's pages are out of reach of the Tab key too */}
                  <div id={`nav-${g.id}`} className="bo-group-panel" inert={!isOpen}>
                    <div className="bo-group-list">
                      {g.links.map((l, i) => (
                        <Link key={l.href} href={l.href} className={isOn(l.href, path) ? "on" : undefined} style={{ "--i": i } as React.CSSProperties}>
                          {l.label}
                          <Count c={counts[l.href]} />
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </nav>
          {/* on a narrow screen, where there is no rail to hold it */}
          <div className="bo-user">
            <span className="bo-avatar" aria-hidden="true">{initial}</span>
            <span>
              <b>{employee ?? "Signed in"}</b>
              {role && <small>{role}</small>}
            </span>
            {leave}
          </div>
        </div>
      </aside>
      {/* once, and outside the menu: it has to open with the menu folded away too */}
      <SearchBox />
    </>
  );
}
