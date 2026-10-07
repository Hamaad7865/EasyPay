"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Back, Chev, fold, NoMatch, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Submit } from "../busy";

export type Category = { id: string; name: string; hex: string; has_color: boolean; sort_order: number; is_stock: boolean; printer_ids: string[]; items: number };
type Action = (f: FormData) => Promise<void>;

// The categories as one table, in the order the till shows them. A line says
// where the category stands, where its items print and whether they are
// counted; tapping it opens it to change any of that, or to remove it.
export function CategoriesTable({ rows, printers, start, save }: { rows: Category[]; printers: { id: string; name: string }[]; start: Start; save: Action }) {
  const t = useTable("/backoffice/categories", start);
  const printerName = useMemo(() => new Map(printers.map((p) => [p.id, p.name])), [printers]);
  const prints = (r: Category) => r.printer_ids.map((id) => printerName.get(id)).filter((n): n is string => Boolean(n));
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold([r.name, ...prints(r), r.is_stock ? "counted stock" : ""].join(" "))])), [rows, printerName]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = t.sorted(
    rows.filter((r) => t.finds(hay.get(r.id)!)),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      order: (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
      items: (a, b) => a.items - b.items || a.name.localeCompare(b.name),
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
              <th>Prints on</th>
              <th>Stock</th>
              <SortTh t={t} k="items" label="Items" num />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={6} what="category" />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              const where = prints(r);
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={r.name} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong">
                    <span className="swatch" style={{ background: r.hex }} />
                    {r.name}
                  </td>
                  <td className="num">{r.sort_order}</td>
                  <td>{where.length ? where.join(", ") : <span className="muted">No printer</span>}</td>
                  <td>{r.is_stock ? <span className="badge blue">Counted</span> : <span className="muted">Not counted</span>}</td>
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
                    <td colSpan={6}>
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
                          <label className="inline muted">
                            Colour
                            <input type="color" name="color" defaultValue={r.hex} aria-label={`Colour for ${r.name}`} />
                          </label>
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" name="is_stock" defaultChecked={r.is_stock} />
                            Stock is counted
                          </label>
                          <div className="open-form-line">
                            <span className="muted">Prints on</span>
                            {printers.length === 0 ? (
                              <span className="muted">No printers are set up.</span>
                            ) : (
                              printers.map((p) => (
                                <label key={p.id} className="check" style={{ margin: 0 }}>
                                  <input type="checkbox" name="printer" value={p.id} defaultChecked={r.printer_ids.includes(p.id)} />
                                  {p.name}
                                </label>
                              ))
                            )}
                            <span className="spacer" />
                            <Submit className="btn-sm">
                              Save
                            </Submit>
                            <Submit name="remove" value="1" className="btn-link danger" formNoValidate>
                              Remove
                            </Submit>
                          </div>
                        </form>
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
