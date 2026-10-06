"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Back, Chev, downloadCsv, fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../table-kit";

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
type Action = (f: FormData) => Promise<void>;

const STATUS = [
  ["", "All"],
  ["on", "On sale"],
  ["out", "Sold out"],
  ["notax", "No tax set"],
] as const;
const LOW = 5000; // five or fewer left, as the Stock page counts it

// The items as one table. A line is an item as the till has it; the box above
// finds it by name, category, SKU or barcode as you type, the two filters
// narrow the list and a column's title sorts by it. Tapping a line opens it
// for what changes day to day: its price, and whether it is on sale. Ticking
// lines takes several off sale (or puts them back) in one go. The rest is on
// the item's own page.
export function ItemsTable({
  items, cats, start, quickSave, bulkSave,
}: {
  items: Item[]; cats: { id: string; name: string }[]; start: Start; quickSave: Action; bulkSave: Action;
}) {
  const t = useTable("/backoffice/items", start);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const cat = t.get("category");
  const status = t.get("status");

  const hay = useMemo(() => new Map(items.map((i) => [i.id, fold([i.name, i.cat ?? "", i.sku ?? "", i.barcode ?? ""].join(" "))])), [items]);
  const shown = t.sorted(
    items.filter(
      (i) =>
        (!cat || (cat === "none" ? !i.cat_id : i.cat_id === cat)) &&
        (!status || (status === "on" ? i.is_available : status === "out" ? !i.is_available : status === "notax" ? !i.tax : true)) &&
        t.finds(hay.get(i.id)!),
    ),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      category: (a, b) => a.cat_order - b.cat_order || (a.cat ?? "").localeCompare(b.cat ?? "") || a.name.localeCompare(b.name),
      price: (a, b) => a.price - b.price || a.name.localeCompare(b.name),
      stock: (a, b) => (a.stock ?? 0) - (b.stock ?? 0) || a.name.localeCompare(b.name),
    },
    { stock: (i) => i.stock === null },
  );

  const soldOut = items.filter((i) => !i.is_available).length;
  const noTax = items.filter((i) => !i.tax).length;
  const withStock = items.some((i) => i.stock !== null);
  const cols = withStock ? 9 : 8;
  // ticking: the box in the title takes every line the list is showing
  const here = shown.filter((i) => picked.has(i.id)).length;
  const pick = (id: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const pickAll = () =>
    setPicked((was) => {
      const next = new Set(was);
      for (const i of shown) here === shown.length ? next.delete(i.id) : next.add(i.id);
      return next;
    });
  const chosen = items.filter((i) => picked.has(i.id));

  // the list as it is on screen, as a file a spreadsheet opens
  const csv = () =>
    downloadCsv("items", [
      ["Item", "Category", "Price", "Tax", "Add-on groups", "SKU", "Barcode", "On sale", "In stock"],
      ...shown.map((i) => [i.name, i.cat ?? "", (i.price / 100).toFixed(2), i.tax ?? "", i.addons, i.sku ?? "", i.barcode ?? "", i.is_available ? "Yes" : "Sold out", i.stock === null ? "" : i.stock / 1000]),
    ]);

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All items</h2>
          <p>
            {shown.length !== items.length ? `${shown.length} of ${items.length}` : items.length} {items.length === 1 ? "item" : "items"}
            {soldOut > 0 && ` · ${soldOut} sold out`}
            {noTax > 0 && ` · ${noTax} with no tax set`}. Tap an item to change its price or take it off sale.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search name, category, SKU, barcode" label="Search items" />
      </div>
      <div className="table-filters">
        <label className="inline muted">
          Category
          <select value={cat} onChange={(e) => t.set("category", e.target.value)}>
            <option value="">All categories</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="none">No category</option>
          </select>
        </label>
        <Seg t={t} name="status" label="Show" options={STATUS} />
        <span className="spacer" />
        <button type="button" className="btn-quiet btn-sm" onClick={csv} title="The list as it is shown, as a file for a spreadsheet">
          <Download aria-hidden="true" />
          Download CSV
        </button>
      </div>
      {chosen.length > 0 && (
        <form action={bulkSave} className="table-bulk" role="region" aria-label="The items ticked">
          <Back t={t} />
          {chosen.map((i) => (
            <input key={i.id} type="hidden" name="id" value={i.id} />
          ))}
          <strong>
            {chosen.length} {chosen.length === 1 ? "item" : "items"} ticked
            {chosen.length > here && ` (${chosen.length - here} not in the list as filtered)`}
          </strong>
          <button type="submit" name="available" value="0" className="btn-sm">
            Mark sold out
          </button>
          <button type="submit" name="available" value="1" className="btn-quiet btn-sm">
            Put back on sale
          </button>
          <span className="spacer" />
          <button type="button" className="btn-link" onClick={() => setPicked(new Set())}>
            Untick all
          </button>
        </form>
      )}
      <div className="table-scroll">
        <table className="rows-open with-ticks">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Tick every item shown"
                  checked={shown.length > 0 && here === shown.length}
                  ref={(el) => {
                    if (el) el.indeterminate = here > 0 && here < shown.length;
                  }}
                  onChange={pickAll}
                />
              </th>
              <th />
              <SortTh t={t} k="name" label="Item" />
              <SortTh t={t} k="category" label="Category" />
              <th>Tax</th>
              <th>Add-ons</th>
              {withStock && <SortTh t={t} k="stock" label="Stock" num />}
              <SortTh t={t} k="price" label="Price" num />
              <th>On sale</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={cols} what="item" filters={["category", "status"]} />}
            {shown.map((it) => {
              const on = t.isOpen(it.id);
              const code = [it.sku && `SKU ${it.sku}`, it.barcode].filter(Boolean).join(" · ");
              return [
                <tr key={it.id} className={on ? "row on" : "row"} onClick={() => t.toggle(it.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Tick ${it.name}`} checked={picked.has(it.id)} onChange={() => pick(it.id)} />
                  </td>
                  <td>
                    <Chev open={on} name={it.name} onClick={() => t.toggle(it.id)} />
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
                          <Back t={t} id={it.id} />
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
