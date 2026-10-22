"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from "lucide-react";
import { Submit, Wait } from "./busy";
import { groupsFor, HOME, groupOf, isOn, over, sectionsFor, type NavCount } from "./nav";
import type { Mode } from "@/lib/mode";
import type { Theme } from "@/lib/theme";
import { ThemeButton, useTheme } from "../theme";
import { openSearch, SearchBox, useSearchKey } from "./search-box";

// The way round the back office, which has two shapes.
//
// The menu: a pane the height of the window down the left edge. At its head
// the name and whose back office this is; then the day's page and three
// sections of pages (Counter, Finance and stock, Admin), where a line is a
// page or a group that opens onto its pages, as many open at once as someone
// likes; at its foot the search, the look, the way out, and who is signed in.
//
// The rail: what the menu folds into. A column of round signs, one for the
// dashboard and one for each group of pages, then the search, who is signed
// in and the switch that brings the menu back. A sign opens its group's
// pages in a small card beside it, so every page is still two taps off and
// the page has the whole width.
//
// Only one of the two shows at a time: beside the open menu the signs said
// nothing the menu did not. Which shape it was left in, and which groups were
// open, is remembered in this browser (two cookies, read before the page is
// drawn so it never opens one way and jumps to the other).

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
const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return two.toUpperCase();
};
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

// Over a page’s heading: the group the page sits in ("Insights" over Sales
// patterns). Nothing on the day’s page, nor on a page that is its own line of
// the menu.
export function Over({ mode, premium, mra }: { mode: Mode; premium: boolean; mra: boolean }) {
  const name = over(usePathname(), mode, premium, mra);
  return name ? <p className="bo-over">{name}</p> : null;
}

export function Side({
  restaurant, id, employee, role, signOut, folded, opened, look, drawn, mode, premium, mra,
}: {
  // a restaurant or a shop: which pages the menu has, and what it calls them
  mode: Mode;
  // the plan carries the premium pages
  premium: boolean;
  // a client on Premium MRA has its MRA page
  mra: boolean;
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
  // light or dark, where one was chosen in this browser (null: as the device is set)
  look: Theme | null;
  // when the server last drew the shell. Going from page to page leaves it
  // alone; a save draws it again, and the numbers in the menu are asked for
  // again then, whatever the save's "saved" line says.
  drawn: number;
}) {
  const path = usePathname();
  const here = groupOf(path, mode, premium, mra);
  const groups = useMemo(() => groupsFor(mode, premium, mra), [mode, premium, mra]);
  const sections = useMemo(() => sectionsFor(mode, premium, mra), [mode, premium, mra]);
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
    if (!next.delete(g)) next.add(g);
    keep(next);
  };
  // The signs pop in when someone folds the menu into them, not every time a
  // page loads with the menu already folded.
  const [turned, setTurned] = useState(false);
  const fold = () => {
    shut();
    setTurned(true);
    remember("bo-menu", away ? "open" : "closed");
    setAway(!away);
  };
  // the switch is drawn twice, in the menu and in the rail's card: one choice behind both
  const [theme, turn] = useTheme(look);
  const initial = (employee ?? "?").trim().slice(0, 1).toUpperCase();
  const Look = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const look_ = theme === "dark" ? "Dark look" : theme === "light" ? "Light look" : "Device's look";
  const lookSay = `Look: ${theme === "dark" ? "dark" : theme === "light" ? "light" : "the same as this device"}. Press to change it.`;
  const dev = process.env.NODE_ENV === "development" ? " dev" : "";
  // the signs come in one after the other when the menu folds into them
  let nth = 0;
  const pop = () => ({ "--i": nth++ }) as React.CSSProperties;
  const leave = (
    <form action={signOut}>
      <Submit title="Sign out" aria-label="Sign out">
        <LogOut aria-hidden="true" />
      </Submit>
    </form>
  );

  return (
    <>
      {/* while developing, Next.js puts its own round badge in the bottom left corner: the rail and the menu stop short of it */}
      <nav className={"rail" + dev} aria-label="Sections" data-folded={away || undefined} data-turned={turned || undefined} inert={!away}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <span className="rail-logo" style={pop()}><img src="/logo-mark.png" alt="EasyPay" /></span>
        <Link href={HOME.href} className={"rail-sign" + (isOn(HOME.href, path) ? " on" : "")} aria-label={HOME.label} data-tip={HOME.label} style={pop()}>
          <HOME.icon aria-hidden="true" strokeWidth={1.9} />
        </Link>
        {groups.map((g) =>
          g.flat ? (
            <Link key={g.id} href={g.links[0].href} className={"rail-sign" + (here === g.id ? " on" : "")} aria-label={g.title} data-tip={g.title} style={pop()}>
              <g.icon aria-hidden="true" strokeWidth={1.9} />
            </Link>
          ) : (
            <div key={g.id} className="rail-item" style={pop()}>
              <button
                type="button"
                className={"rail-sign" + (here === g.id ? " on" : "")}
                aria-label={g.title}
                data-tip={g.title}
                popoverTarget={`rail-${g.id}`}
                onClick={(e) => place(e.currentTarget, `rail-${g.id}`)}
              >
                <g.icon aria-hidden="true" strokeWidth={1.9} />
              </button>
              <div id={`rail-${g.id}`} popover="auto" className="rail-card">
                <b>{g.title}</b>
                {g.links.map((l, i) => (
                  <Link key={l.href} href={l.href} className={isOn(l.href, path) ? "on" : undefined} style={{ "--i": i } as React.CSSProperties} onClick={shut}>
                    <l.icon aria-hidden="true" strokeWidth={1.9} />
                    {l.label}
                    <Wait />
                    <Count c={counts[l.href]} />
                  </Link>
                ))}
              </div>
            </div>
          ),
        )}
        <span className="rail-gap" />
        <button type="button" className="rail-sign" aria-label="Search" data-tip={`Search (${key})`} style={pop()} onClick={openSearch}>
          <Search aria-hidden="true" strokeWidth={1.9} />
        </button>
        <div className="rail-item" style={pop()}>
          <button type="button" className="rail-sign rail-me" aria-label={`${employee ?? "Signed in"}: account`} data-tip={employee ?? "Signed in"} popoverTarget="rail-me" onClick={(e) => place(e.currentTarget, "rail-me", true)}>
            {initial}
          </button>
          <div id="rail-me" popover="auto" className="rail-card rail-who">
            <span className="bo-avatar" aria-hidden="true">{initial}</span>
            <span>
              <b>{employee ?? "Signed in"}</b>
              {role && <small>{role}</small>}
            </span>
            <ThemeButton theme={theme} turn={turn} />
            {leave}
          </div>
        </div>
        <button type="button" className="rail-sign" aria-label="Show the menu" aria-expanded={false} aria-controls="bo-menu" data-tip="Show the menu" style={pop()} onClick={fold}>
          <PanelLeftOpen aria-hidden="true" strokeWidth={1.9} />
        </button>
      </nav>

      {/* folded away, its links are out of reach of the Tab key too */}
      <aside className={"bo-side" + dev} id="bo-menu" data-folded={away || undefined} inert={away && !narrow}>
        <div className="bo-side-in">
          <div className="bo-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.png" alt="" className="bo-brand-logo" />
            <span>
              Easy<span className="bo-brand-pos">Pay</span>
            </span>
          </div>
          <div className="bo-restaurant" title={restaurant}>
            <span className="bo-tile" aria-hidden="true">{initials(restaurant)}</span>
            <span>
              <b>{restaurant}</b>
              <small>ID {id}</small>
            </span>
          </div>
          <nav className="bo-nav" ref={nav} aria-label="Back office">
            <Link href={HOME.href} className={"bo-nav-top" + (isOn(HOME.href, path) ? " on" : "")}>
              <HOME.icon aria-hidden="true" strokeWidth={1.8} />
              <span>{HOME.label}</span>
              <Wait />
            </Link>
            {sections.map((sec) => (
              <div key={sec.id} className="bo-section" role="group" aria-label={sec.title}>
                <p className="bo-section-title">{sec.title}</p>
                {sec.groups.map((g) => {
                  if (g.flat) {
                    const l = g.links[0];
                    return (
                      <Link key={g.id} href={l.href} className={"bo-nav-top" + (isOn(l.href, path) ? " on" : "")}>
                        <g.icon aria-hidden="true" strokeWidth={1.8} />
                        <span>{g.title}</span>
                        <Wait />
                        <Count c={counts[l.href]} />
                      </Link>
                    );
                  }
                  const isOpen = open.has(g.id);
                  return (
                    <div key={g.id} className={"bo-group" + (isOpen ? " open" : "") + (here === g.id ? " here" : "")}>
                      <button type="button" id={`nav-head-${g.id}`} className="bo-group-head" aria-expanded={isOpen} aria-controls={`nav-${g.id}`} onClick={() => toggle(g.id)}>
                        <g.icon aria-hidden="true" strokeWidth={1.8} />
                        <span>{g.title}</span>
                        <ChevronDown aria-hidden="true" className="bo-group-chev" strokeWidth={2} />
                      </button>
                      {/* a closed group's pages are out of reach of the Tab key too */}
                      <div id={`nav-${g.id}`} className="bo-group-panel" inert={!isOpen}>
                        <div className="bo-group-list">
                          {g.links.map((l) => (
                            <Link key={l.href} href={l.href} className={isOn(l.href, path) ? "on" : undefined}>
                              <span>{l.label}</span>
                              <Wait />
                              <Count c={counts[l.href]} />
                            </Link>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </nav>
          {/* the small keys at the foot, two to a line */}
          <div className="bo-foot">
            <button type="button" onClick={openSearch} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" title={`Search (${key})`}>
              <Search aria-hidden="true" strokeWidth={1.8} />
              Search
            </button>
            <button type="button" aria-expanded={true} aria-controls="bo-menu" onClick={fold} title="Fold the menu away">
              <PanelLeftClose aria-hidden="true" strokeWidth={1.8} />
              Hide menu
            </button>
            <button type="button" onClick={turn} title={lookSay} aria-label={lookSay}>
              <Look aria-hidden="true" strokeWidth={1.8} />
              {look_}
            </button>
            <form action={signOut}>
              <Submit>
                <LogOut aria-hidden="true" strokeWidth={1.8} />
                Sign out
              </Submit>
            </form>
          </div>
          <div className="bo-user">
            <span className="bo-tile" aria-hidden="true">{initials(employee ?? "?")}</span>
            <span>
              <b>{employee ?? "Signed in"}</b>
              {role && <small>{role}</small>}
            </span>
          </div>
        </div>
      </aside>
      {/* once, and outside the menu: it has to open with the menu folded away too */}
      <SearchBox mode={mode} premium={premium} mra={mra} />
    </>
  );
}
