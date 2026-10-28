"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Back, Chev, fold, NoMatch, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Submit } from "../busy";
import type { Mode } from "@/lib/mode";

export type Category = {
  id: string;
  name: string;
  hex: string;
  has_color: boolean;
  sort_order: number;
  is_stock: boolean;
  printer_ids: string[];
  items: number;
  mra_nature: string | null;
  // a sub category (0145): the category it is under, and whether it keeps that one's settings
  parent_id: string | null;
  parent_name: string | null;
  parent_order: number;
  follows_parent: boolean;
  subs: number;
};
type Action = (f: FormData) => Promise<void>;

// "Shirt › Long Sleeve" for a sub category, its own name for a category.
const path = (r: Category) => (r.parent_name ? `${r.parent_name} › ${r.name}` : r.name);

// The categories as one table, in the order the till shows them, each sub
// category under its own. A line says where the category stands, where its
// items print and whether they are counted; tapping it opens it to change any
// of that, to put it under another, to add a sub category, or to remove it.
// mraBusiness: for a Premium MRA client (0116), what the business sells ("" not
// said yet); a category may say otherwise. Left out for any other client.
export function CategoriesTable({
  rows,
  printers,
  start,
  save,
  add,
  mode,
  mraBusiness,
}: {
  rows: Category[];
  printers: { id: string; name: string }[];
  start: Start;
  save: Action;
  add: Action;
  mode: Mode;
  mraBusiness?: string;
}) {
  const shop = mode === "retail";
  // a shop's categories have no "Prints on" and no "Stock" column
  const cols = shop ? 4 : 6;
  const t = useTable("/backoffice/categories", start);
  const printerName = useMemo(() => new Map(printers.map((p) => [p.id, p.name])), [printers]);
  const prints = (r: Category) => r.printer_ids.map((id) => printerName.get(id)).filter((n): n is string => Boolean(n));
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold([path(r), ...prints(r), r.is_stock ? "counted stock" : ""].join(" "))])), [rows, printerName]); // eslint-disable-line react-hooks/exhaustive-deps
  const tops = rows.filter((r) => !r.parent_id);
  // in the till's order: a category, then its subs in their own order
  const top = (r: Category) => (r.parent_id ? r.parent_name ?? "" : r.name);
  const shown = t.sorted(
    rows.filter((r) => t.finds(hay.get(r.id)!)),
    {
      name: (a, b) => path(a).localeCompare(path(b)),
      order: (a, b) =>
        a.parent_order - b.parent_order ||
        top(a).localeCompare(top(b)) ||
        Number(Boolean(a.parent_id)) - Number(Boolean(b.parent_id)) ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name),
      items: (a, b) => a.items - b.items || path(a).localeCompare(path(b)),
    },
  );
  const items = rows.reduce((a, r) => a + r.items, 0);

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All categories</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "category" : "categories"} · {items} {items === 1 ? "item" : "items"} in them. Tap a category
            to change it.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search categories" label="Search categories" />
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              <SortTh t={t} k="name" label="Category" />
              <SortTh t={t} k="order" label="Sequence" num />
              {!shop && <th>Prints on</th>}
              {!shop && <th>Stock</th>}
              <SortTh t={t} k="items" label="Items" num />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={cols} what="category" />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              const where = prints(r);
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={r.name} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong" style={r.parent_id ? { paddingLeft: 28 } : undefined}>
                    <span className="swatch" style={{ background: r.hex }} />
                    {r.parent_id && <span className="muted">{r.parent_name} › </span>}
                    {r.name}
                    {r.subs > 0 && <span className="muted"> · {r.subs === 1 ? "1 sub category" : `${r.subs} sub categories`}</span>}
                  </td>
                  <td className="num">{r.sort_order}</td>
                  {!shop && <td>{where.length ? where.join(", ") : <span className="muted">No printer</span>}</td>}
                  {!shop && <td>{r.is_stock ? <span className="badge blue">Counted</span> : <span className="muted">Not counted</span>}</td>}
                  <td className="num">
                    {r.items > 0 ? (
                      <Link href={`/backoffice/items?category=${r.id}`} onClick={(e) => e.stopPropagation()}>
                        {r.items}
                      </Link>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                </tr>,
                on && (
                  <tr key={r.id + "-open"} className="open-body">
                    <td colSpan={cols}>
                      <div className="open-panel">
                        <form action={save} className="open-form">
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} id={r.id} />
                          <label className="inline muted">
                            Name
                            <input name="name" defaultValue={r.name} required maxLength={40} style={{ fontWeight: 600 }} />
                          </label>
                          <label className="inline muted">
                            Sequence
                            <input name="sort_order" type="number" min={0} max={999} defaultValue={r.sort_order} className="narrow" />
                          </label>
                          {r.subs === 0 && (
                            <label className="inline muted">
                              Under
                              <select name="parent" defaultValue={r.parent_id ?? ""}>
                                <option value="">Nothing: a category</option>
                                {tops
                                  .filter((p) => p.id !== r.id)
                                  .map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          )}
                          {r.subs === 0 && (
                            <label className="check" style={{ margin: 0 }}>
                              <input type="checkbox" name="follows" defaultChecked={r.parent_id ? r.follows_parent : true} />
                              {r.parent_name ? `Same settings as ${r.parent_name}` : "Same settings as the category it goes under"}
                            </label>
                          )}
                          <label className="inline muted">
                            Colour
                            <input type="color" name="color" defaultValue={r.hex} aria-label={`Colour for ${r.name}`} />
                          </label>
                          {mraBusiness !== undefined && (
                            <label className="inline muted">
                              Goods or services
                              <select name="mra_nature" defaultValue={r.mra_nature ?? ""}>
                                <option value="">As the business{mraBusiness ? ` (${mraBusiness === "goods" ? "goods" : "services"})` : ""}</option>
                                <option value="goods">Goods</option>
                                <option value="services">Services</option>
                              </select>
                            </label>
                          )}
                          {!shop && (
                            <label className="check" style={{ margin: 0 }}>
                              <input type="checkbox" name="is_stock" defaultChecked={r.is_stock} />
                              Stock is counted
                            </label>
                          )}
                          <div className="open-form-line">
                            {!shop && <span className="muted">Prints on</span>}
                            {!shop &&
                              (printers.length === 0 ? (
                                <span className="muted">No printers are set up.</span>
                              ) : (
                                printers.map((p) => (
                                  <label key={p.id} className="check" style={{ margin: 0 }}>
                                    <input type="checkbox" name="printer" value={p.id} defaultChecked={r.printer_ids.includes(p.id)} />
                                    {p.name}
                                  </label>
                                ))
                              ))}
                            <span className="spacer" />
                            <Submit className="btn-sm">
                              Save
                            </Submit>
                            <Submit name="remove" value="1" className="btn-link danger" formNoValidate>
                              Remove
                            </Submit>
                          </div>
                        </form>
                        {!r.parent_id && (
                          <form action={add} className="open-form" style={{ marginTop: 12 }}>
                            <input type="hidden" name="parent" value={r.id} />
                            <Back t={t} id={r.id} />
                            <label className="inline muted">
                              Sub category of {r.name}
                              <input name="name" placeholder="Long Sleeve" required maxLength={40} />
                            </label>
                            <Submit className="btn-sm">Add sub category</Submit>
                          </form>
                        )}
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
