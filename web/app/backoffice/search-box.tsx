"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Contact, CornerDownLeft, LayoutGrid, type LucideIcon, Search, Tags, Users, UtensilsCrossed } from "lucide-react";
import { pagesOf } from "./nav";
import type { Mode } from "@/lib/mode";
import type { HitGroup } from "./search/hits";

// The search (Ctrl K, or ⌘K on a Mac). Pages are found here, at once, from
// the same list the side menu is drawn from; items, categories, customers,
// tables and staff are asked of the server once typing pauses. This is the box
// alone, put on the page once: the field in the menu and the sign on the rail
// open it with openSearch().

type Row = { key: string; title: string; sub: string; href: string; icon: LucideIcon };
type Section = { label: string; rows: Row[] };

const KIND_ICON: Record<HitGroup["kind"], LucideIcon> = { items: UtensilsCrossed, categories: Tags, customers: Contact, tables: LayoutGrid, staff: Users };
// what the empty box offers
const START = ["/backoffice", "/backoffice/insights/sales", "/backoffice/reports/sales", "/backoffice/items", "/backoffice/receipts", "/backoffice/settings"];

type Page = ReturnType<typeof pagesOf>[number];

function pagesFor(q: string, all: Page[]): Row[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = words.length
    ? all.filter((p) => {
        const hay = `${p.label} ${p.group ?? ""} ${p.words ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }).sort((a, b) => Number(b.label.toLowerCase().startsWith(words[0])) - Number(a.label.toLowerCase().startsWith(words[0])))
    : START.map((href) => all.find((p) => p.href === href)).filter((p): p is Page => Boolean(p));
  return list.slice(0, 7).map((p) => ({ key: p.href, title: p.label, sub: p.group ?? "Home", href: p.href, icon: p.icon }));
}

const OPEN = "easypay:search";
export const openSearch = () => window.dispatchEvent(new Event(OPEN));

// The shortcut as this visitor's keyboard names it, so only known in the browser.
export function useSearchKey() {
  const [key, setKey] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setKey("⌘K");
  }, []);
  return key;
}

export function SearchBox({ mode, premium }: { mode: Mode; premium: boolean }) {
  const all = useMemo(() => pagesOf(mode, premium), [mode, premium]);
  const router = useRouter();
  const path = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<HitGroup[]>([]);
  const [asking, setAsking] = useState(false);
  const [at, setAt] = useState(0);

  const show = () => {
    if (dialog.current?.open) return;
    setQ("");
    setFound([]);
    setAt(0);
    dialog.current?.showModal();
    input.current?.focus();
  };
  const hide = () => dialog.current?.close();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) hide();
        else show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN, show);
    };
  }, []);

  // arriving on a page closes the search
  useEffect(() => hide(), [path]);

  // the records, once typing has paused; an answer to an older question is dropped
  const term = q.trim();
  useEffect(() => {
    if (term.length < 2) {
      setFound([]);
      setAsking(false);
      return;
    }
    setAsking(true);
    const stop = new AbortController();
    const wait = setTimeout(async () => {
      try {
        const res = await fetch("/backoffice/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: term }),
          signal: stop.signal,
        });
        const data = res.ok && res.headers.get("content-type")?.includes("json") ? ((await res.json()) as { groups?: HitGroup[] }) : {};
        setFound(data.groups ?? []);
      } catch {
        // stopped, or no connection: the pages are still there
      }
      if (!stop.signal.aborted) setAsking(false);
    }, 180);
    return () => {
      clearTimeout(wait);
      stop.abort();
    };
  }, [term]);

  const sections = useMemo<Section[]>(() => {
    const pages = pagesFor(term, all);
    const out: Section[] = [];
    if (pages.length) out.push({ label: term ? "Pages" : "Go to", rows: pages });
    for (const g of found) {
      out.push({ label: g.label, rows: g.hits.map((h, i) => ({ key: `${g.kind}-${i}-${h.href}`, title: h.title, sub: h.sub, href: h.href, icon: KIND_ICON[g.kind] })) });
    }
    return out;
  }, [term, found, all]);
  const flat = sections.flatMap((s) => s.rows);
  const on = Math.min(at, Math.max(flat.length - 1, 0));

  const go = (row: Row | undefined) => {
    if (!row) return;
    hide();
    router.push(row.href);
  };
  const move = (by: number) => {
    if (!flat.length) return;
    const next = (on + by + flat.length) % flat.length;
    setAt(next);
    document.getElementById(`search-row-${next}`)?.scrollIntoView({ block: "nearest" });
  };

  let n = -1;
  return (
    <>
      <dialog
        ref={dialog}
        className="search-dialog"
        aria-label="Search the back office"
        // a click on the dimmed page around the box closes it
        onClick={(e) => e.target === dialog.current && hide()}
      >
        <div className="search-panel">
          <div className="search-field">
            <Search aria-hidden="true" />
            <input
              ref={input}
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setAt(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") (e.preventDefault(), move(1));
                else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
                else if (e.key === "Enter") (e.preventDefault(), go(flat[on]));
                else if (e.key === "Escape") (e.preventDefault(), hide());
              }}
              placeholder="Search pages, items, categories, customers, tables…"
              role="combobox"
              aria-expanded="true"
              aria-controls="search-results"
              aria-activedescendant={flat.length ? `search-row-${on}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
            />
            {asking && <i className="search-busy" aria-hidden="true" />}
          </div>
          <div className="search-results" id="search-results" role="listbox" aria-label="Results">
            {sections.map((s) => (
              <div key={s.label} role="group" aria-label={s.label}>
                <div className="search-label">{s.label}</div>
                {s.rows.map((r) => {
                  n += 1;
                  const i = n;
                  return (
                    <a
                      key={r.key}
                      id={`search-row-${i}`}
                      href={r.href}
                      role="option"
                      aria-selected={i === on}
                      className={i === on ? "on" : undefined}
                      onMouseMove={() => i !== on && setAt(i)}
                      onClick={(e) => {
                        e.preventDefault();
                        go(r);
                      }}
                    >
                      <span className="search-ico">
                        <r.icon aria-hidden="true" strokeWidth={1.9} />
                      </span>
                      <span className="search-text">
                        <b>{r.title}</b>
                        <small>{r.sub}</small>
                      </span>
                      <CornerDownLeft aria-hidden="true" className="search-enter" />
                    </a>
                  );
                })}
              </div>
            ))}
            {!flat.length && !asking && <p className="search-none">Nothing matches “{term}”. Try a page name, an item, a category or a customer.</p>}
          </div>
          <div className="search-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> to move
            </span>
            <span>
              <kbd>Enter</kbd> to open
            </span>
            <span>
              <kbd>Esc</kbd> to close
            </span>
          </div>
        </div>
      </dialog>
    </>
  );
}
