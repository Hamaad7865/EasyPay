"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown, Search } from "lucide-react";

export type Item = {
  id: string;
  name: string;
  // cents, and the same amount as the till shows it
  price: number;
  shown: string;
  is_available: boolean;
  cat_id: string | null;
  cat: string | null;
  cat_color: string | null;
  // where its category stands in the menu's own order
  cat_order: number;
  sku: string | null;
  barcode: string | null;
  tax: string | null;
  addons: number;
  // null when the item's stock is not counted
  stock: number | null;
  stock_shown: string;
};
// what the address asked for: /backoffice/items?category=...&q=...&status=...&sort=...&open=...
export type Start = { cat: string; q: string; status: string; sort: string; open: string };
type Action = (f: FormData) => Promise<void>;
type SortKey = "name" | "category" | "price" | "stock";

const STATUS = [
  ["", "All"],
  ["on", "On sale"],
  ["out", "Sold out"],
  ["notax", "No tax set"],
] as const;
const LOW = 5000; // five or fewer left, as the Stock page counts it

// Typed without its accents, "gateau" still finds "Gâteau".
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// The items as one table, like Add-ons. A line is an item as the till has it;
// the box above finds it by name, category, SKU or barcode as you type, the
// two filters narrow the list and a column's title sorts by it. Tapping a
// line opens it for what changes day to day: its price, and whether it is on
// sale. The rest is on the item's own page.
export function ItemsTable({ items, cats, start, quickSave }: { items: Item[]; cats: { id: string; name: string }[]; start: Start; quickSave: Action }) {
  const [q, setQ] = useState(start.q);
  const [cat, setCat] = useState(start.cat);
  const [status, setStatus] = useState(STATUS.some(([v]) => v === start.status) ? start.status : "");
  const [sort, setSort] = useState(/^-?(name|category|price|stock)$/.test(start.sort) ? start.sort : "");
  const [open, setOpen] = useState<Set<string>>(() => new Set(start.open ? [start.open] : []));

  // The address follows the filters, so a save (which comes back to the
  // address) and a reload both keep the list as it was left.
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (cat) p.set("category", cat);
    if (q.trim()) p.set("q", q.trim());
    if (status) p.set("status", status);
    if (sort) p.set("sort", sort);
    return p;
  }, [cat, q, status, sort]);
  useEffect(() => {
    const s = query.toString();
    window.history.replaceState(null, "", "/backoffice/items" + (s ? "?" + s : ""));
  }, [query]);
  const back = (id: string) => {
    const p = new URLSearchParams(query);
    p.set("open", id);
    return "/backoffice/items?" + p.toString();
  };

  const hay = useMemo(() => new Map(items.map((i) => [i.id, fold([i.name, i.cat ?? "", i.sku ?? "", i.barcode ?? ""].join(" "))])), [items]);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const key = sort.replace("-", "") as SortKey | "";
  const down = sort.startsWith("-");
  const shown = useMemo(() => {
    const list = items.filter(
      (i) =>
        (!cat || (cat === "none" ? !i.cat_id : i.cat_id === cat)) &&
        (!status || (status === "on" ? i.is_available : status === "out" ? !i.is_available : !i.tax)) &&
        words.every((w) => hay.get(i.id)!.includes(w)),
    );
    if (!key) return list;
    const by: Record<SortKey, (a: Item, b: Item) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      category: (a, b) => a.cat_order - b.cat_order || (a.cat ?? "").localeCompare(b.cat ?? "") || a.name.localeCompare(b.name),
      price: (a, b) => a.price - b.price || a.name.localeCompare(b.name),
      // items whose stock is not counted go last, whichever way the column is sorted
      stock: (a, b) => (a.stock === null ? 1 : b.stock === null ? -1 : (a.stock - b.stock) * (down ? -1 : 1) || a.name.localeCompare(b.name)),
    };
    const sorted = [...list].sort(by[key]);
    return down && key !== "stock" ? sorted.reverse() : sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cat, status, q, sort]);

  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const soldOut = items.filter((i) => !i.is_available).length;
  const noTax = items.filter((i) => !i.tax).length;
  const filtered = shown.length !== items.length;
  const withStock = items.some((i) => i.stock !== null);
  const cols = withStock ? 8 : 7;

  // a column's title: once sorts by it, twice turns it round, a third time lets go
  const head = (k: SortKey, label: string, num = false) => {
    const mine = key === k;
    const Icon = !mine ? ChevronsUpDown : down ? ArrowDown : ArrowUp;
    return (
      <th className={num ? "num" : undefined} aria-sort={mine ? (down ? "descending" : "ascending") : "none"}>
        <button type="button" className={"th-sort" + (mine ? " on" : "")} onClick={() => setSort(!mine ? k : down ? "" : "-" + k)}>
          {label}
          <Icon aria-hidden="true" />
        </button>
      </th>
    );
  };

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All items</h2>
          <p>
            {filtered ? `${shown.length} of ${items.length}` : items.length} {items.length === 1 ? "item" : "items"}
            {soldOut > 0 && ` · ${soldOut} sold out`}
            {noTax > 0 && ` · ${noTax} with no tax set`}. Tap an item to change its price or take it off sale.
          </p>
        </div>
        <label className="table-search">
          <Search aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, category, SKU, barcode" aria-label="Search items" />
        </label>
      </div>
      <div className="table-filters">
        <label className="inline muted">
          Category
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">All categories</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="none">No category</option>
          </select>
        </label>
        <div className="seg" role="radiogroup" aria-label="Show">
          {STATUS.map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="items-status" checked={status === v} onChange={() => setStatus(v)} />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              {head("name", "Item")}
              {head("category", "Category")}
              <th>Tax</th>
              <th>Add-ons</th>
              {withStock && head("stock", "Stock", true)}
              {head("price", "Price", true)}
              <th>On sale</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={cols} className="muted" style={{ textAlign: "center", padding: "28px 16px" }}>
                  No item matches.{" "}
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => {
                      setQ("");
                      setCat("");
                      setStatus("");
                    }}
                  >
                    Show all items
                  </button>
                </td>
              </tr>
            )}
            {shown.map((it) => {
              const on = open.has(it.id);
              const code = [it.sku && `SKU ${it.sku}`, it.barcode].filter(Boolean).join(" · ");
              return [
                <tr key={it.id} className={on ? "row on" : "row"} onClick={() => toggle(it.id)}>
                  <td>
                    <button
                      type="button"
                      className="chev"
                      aria-expanded={on}
                      aria-label={(on ? "Close " : "Open ") + it.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(it.id);
                      }}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </td>
                  <td>
                    <Link href={`/backoffice/items/edit?id=${it.id}`} className="strong" onClick={(e) => e.stopPropagation()}>
                      {it.name}
                    </Link>
                    {code && <small className="cell-sub">{code}</small>}
                  </td>
                  <td>
                    {it.cat ? (
                      <>
                        {it.cat_color && <span className="swatch" style={{ background: it.cat_color }} />}
                        {it.cat}
                      </>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td>{it.tax ?? <span className="badge amber">No tax set</span>}</td>
                  <td>{it.addons > 0 ? `${it.addons} ${it.addons === 1 ? "group" : "groups"}` : <span className="muted">None</span>}</td>
                  {withStock && (
                    <td className="num">
                      {it.stock === null ? <span className="muted">Not counted</span> : it.stock <= LOW ? <span className="badge amber">{it.stock_shown} left</span> : it.stock_shown}
                    </td>
                  )}
                  <td className="num strong">{it.shown}</td>
                  <td>{it.is_available ? <span className="badge green">On sale</span> : <span className="badge red">Sold out</span>}</td>
                </tr>,
                on && (
                  <tr key={it.id + "-open"} className="open-body">
                    <td colSpan={cols}>
                      <div className="open-panel">
                        <form action={quickSave} className="bo-toolbar" style={{ margin: 0 }}>
                          <input type="hidden" name="id" value={it.id} />
                          <input type="hidden" name="back" value={back(it.id)} />
                          <label className="inline muted">
                            Price (Rs)
                            <input name="price" defaultValue={(it.price / 100).toString()} className="narrow" inputMode="decimal" aria-label={`Price of ${it.name}`} />
                          </label>
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" name="available" defaultChecked={it.is_available} />
                            On sale
                          </label>
                          <span className="spacer" />
                          <button type="submit" className="btn-sm">
                            Save
                          </button>
                          <Link href={`/backoffice/items/edit?id=${it.id}`} className="btn btn-quiet btn-sm">
                            Open the item
                          </Link>
                        </form>
                        <p className="muted open-hint">Its name, category, tax and add-ons are on the item&apos;s own page.</p>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
