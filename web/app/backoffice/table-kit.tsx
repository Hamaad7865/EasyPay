"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown, Search } from "lucide-react";

// What every list in the back office is made of (Items, Categories, Stock,
// Customers, Discounts): one card, a box that finds a line as you type,
// filters, column titles that sort, and lines that open to be changed.
//
// What the list is showing (the words in the box, the filters, the sort, the
// line that is open) is kept in the address. A save comes back to the address
// and a reload reads it, so the list is found as it was left, and a link from
// another page (/backoffice/items?category=...) arrives already narrowed.
// The page reads the address and hands it down as `start`; it keys the table
// by it, so arriving with another address starts the table again from that.

export type Start = Record<string, string>;

// Typed without its accents, "gateau" still finds "Gâteau".
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export type Table = ReturnType<typeof useTable>;

export function useTable(path: string, start: Start) {
  const [state, setState] = useState<Start>(() => {
    const rest = { ...start };
    delete rest.open;
    return rest;
  });
  const [open, setOpen] = useState<Set<string>>(() => new Set(start.open ? [start.open] : []));

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) if (v.trim()) p.set(k, v.trim());
    return p;
  }, [state]);
  // After every draw, not only when a filter moves: a save comes back with
  // its "saved" line in the address, and that must not outlive the draw.
  useEffect(() => {
    const s = query.toString();
    const want = path + (s ? "?" + s : "");
    if (window.location.pathname + window.location.search !== want) window.history.replaceState(null, "", want);
  });

  const get = (k: string) => state[k] ?? "";
  const sort = /^-?[a-z0-9]+$/.test(get("sort")) ? get("sort") : "";
  const sortKey = sort.replace("-", "");
  const down = sort.startsWith("-");
  const words = useMemo(() => fold(state.q ?? "").split(/\s+/).filter(Boolean), [state.q]);

  return {
    get,
    set: (k: string, v: string) => setState((was) => ({ ...was, [k]: v })),
    // back to the whole list: the words and the named filters let go
    clear: (...keys: string[]) => setState((was) => ({ ...was, q: "", ...Object.fromEntries(keys.map((k) => [k, ""])) })),
    words,
    // does this line hold every word in the box? `hay` is the line's own words, folded
    finds: (hay: string) => words.every((w) => hay.includes(w)),
    sortKey,
    down,
    // a column's title: once sorts by it, twice turns it round, a third time lets go
    sortBy: (k: string) => setState((was) => ({ ...was, sort: sortKey !== k ? k : down ? "" : "-" + k })),
    // The list in the order asked for. `by` compares two lines upwards for
    // each column; `blank` says which lines have nothing in a column: those go
    // last whichever way it is sorted.
    sorted: <T,>(list: T[], by: Record<string, (a: T, b: T) => number>, blank: Record<string, (r: T) => boolean> = {}): T[] => {
      const cmp = by[sortKey];
      if (!cmp) return list;
      const empty = blank[sortKey];
      const full = [...(empty ? list.filter((r) => !empty(r)) : list)].sort(cmp);
      if (down) full.reverse();
      return empty ? [...full, ...list.filter(empty)] : full;
    },
    isOpen: (id: string) => open.has(id),
    toggle: (id: string) =>
      setOpen((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    // Where a save comes back to: this list as it is, with that line open.
    // `without` leaves out what should not be there on the way back (the
    // panel that was open while saving).
    back: (id?: string, without: string[] = []) => {
      const p = new URLSearchParams(query);
      for (const k of without) p.delete(k);
      if (id) p.set("open", id);
      const s = p.toString();
      return path + (s ? "?" + s : "");
    },
  };
}

// The box in the card's head.
export function TableSearch({ t, placeholder, label }: { t: Table; placeholder: string; label: string }) {
  return (
    <label className="table-search">
      <Search aria-hidden="true" />
      <input type="search" value={t.get("q")} onChange={(e) => t.set("q", e.target.value)} placeholder={placeholder} aria-label={label} />
    </label>
  );
}

// A column title that sorts by its column.
export function SortTh({ t, k, label, num }: { t: Table; k: string; label: string; num?: boolean }) {
  const mine = t.sortKey === k;
  const Icon = !mine ? ChevronsUpDown : t.down ? ArrowDown : ArrowUp;
  return (
    <th className={num ? "num" : undefined} aria-sort={mine ? (t.down ? "descending" : "ascending") : "none"}>
      <button type="button" className={"th-sort" + (mine ? " on" : "")} onClick={() => t.sortBy(k)}>
        {label}
        <Icon aria-hidden="true" />
      </button>
    </th>
  );
}

// A filter with a few choices, side by side. `name` is its name in the address.
export function Seg({ t, name, label, options }: { t: Table; name: string; label: string; options: readonly (readonly [string, string])[] }) {
  const value = options.some(([v]) => v === t.get(name)) ? t.get(name) : "";
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <label key={v}>
          <input type="radio" name={"seg-" + name} checked={value === v} onChange={() => t.set(name, v)} />
          {text}
        </label>
      ))}
    </div>
  );
}

// The arrow at the start of a line that opens.
export function Chev({ open, name, onClick }: { open: boolean; name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="chev"
      aria-expanded={open}
      aria-label={(open ? "Close " : "Open ") + name}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

// The one line a list shows when the box and the filters leave nothing.
export function NoMatch({ t, cols, what, filters = [] }: { t: Table; cols: number; what: string; filters?: string[] }) {
  return (
    <tr>
      <td colSpan={cols} className="muted" style={{ textAlign: "center", padding: "28px 16px" }}>
        No {what} matches.{" "}
        <button type="button" className="btn-link" onClick={() => t.clear(...filters)}>
          Show them all
        </button>
      </td>
    </tr>
  );
}

// The hidden field that tells a save where to come back to.
export function Back({ t, id }: { t: Table; id?: string }) {
  return <input type="hidden" name="back" value={t.back(id)} />;
}

// A list as a file a spreadsheet opens. A cell a spreadsheet would run as a
// formula (a name starting with = + - or @) is marked as plain text, and the
// mark at the start tells Excel the file is UTF-8, so "sautées" stays "sautées".
export function downloadCsv(name: string, rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    if (typeof v === "number") return String(v);
    let s = v.replace(/\s+/g, " ").trim();
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
