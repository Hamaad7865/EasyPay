"use client";

import { useMemo } from "react";
import { Back, Chev, fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../table-kit";

// quantities are thousandths; `q_shown` and `sold7_shown` are the same as people read them
export type StockRow = { id: string; name: string; cat: string | null; cat_order: number; q: number; q_shown: string; sold7: number; sold7_shown: string };
type Action = (f: FormData) => Promise<void>;

const LOW = 5000; // five or fewer left is "low"
const SHOW = [
  ["", "All"],
  ["low", "Low and out"],
  ["out", "Out of stock"],
] as const;

// What is left of the items that are counted, as one table. Tapping a line
// opens it to add a delivery or to set the quantity after counting the shelf.
export function StockTable({ rows, start, change }: { rows: StockRow[]; start: Start; change: Action }) {
  const t = useTable("/backoffice/stock", start);
  const show = t.get("show");
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold(`${r.name} ${r.cat ?? ""}`)])), [rows]);
  const shown = t.sorted(
    rows.filter((r) => (!show || (show === "low" ? r.q <= LOW : show === "out" ? r.q <= 0 : true)) && t.finds(hay.get(r.id)!)),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      category: (a, b) => a.cat_order - b.cat_order || (a.cat ?? "").localeCompare(b.cat ?? "") || a.name.localeCompare(b.name),
      stock: (a, b) => a.q - b.q || a.name.localeCompare(b.name),
      sold: (a, b) => a.sold7 - b.sold7 || a.name.localeCompare(b.name),
    },
  );

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>Counted items</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "item" : "items"}. Tap one to add a delivery or set its quantity.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search item or category" label="Search stock" />
      </div>
      <div className="table-filters">
        <Seg t={t} name="show" label="Show" options={SHOW} />
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              <SortTh t={t} k="name" label="Item" />
              <SortTh t={t} k="category" label="Category" />
              <SortTh t={t} k="stock" label="In stock" num />
              <th>Status</th>
              <SortTh t={t} k="sold" label="Sold in 7 days" num />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={6} what="item" filters={["show"]} />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={r.name} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong">{r.name}</td>
                  <td>{r.cat ?? <span className="muted">None</span>}</td>
                  <td className="num strong">{r.q_shown}</td>
                  <td>{r.q <= 0 ? <span className="badge red">Out</span> : r.q <= LOW ? <span className="badge amber">Low</span> : <span className="badge green">In stock</span>}</td>
                  <td className="num">{r.sold7 > 0 ? r.sold7_shown : <span className="muted">None</span>}</td>
                </tr>,
                on && (
                  <tr key={r.id + "-open"} className="open-body">
                    <td colSpan={6}>
                      <div className="open-panel">
                        <form action={change} className="bo-toolbar" style={{ margin: 0 }}>
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} id={r.id} />
                          <select name="mode" defaultValue="add" aria-label="How">
                            <option value="add">Add (a delivery; minus to take away)</option>
                            <option value="set">Set to (the shelf was counted)</option>
                          </select>
                          <input name="qty" required className="narrow" inputMode="decimal" placeholder="0" aria-label={`Quantity for ${r.name}`} />
                          <input name="note" maxLength={120} placeholder="Note, for example the supplier" aria-label="Note" style={{ flex: "1 1 220px" }} />
                          <button type="submit" className="btn-sm">
                            Save
                          </button>
                        </form>
                        <p className="muted open-hint">
                          {r.q_shown} in stock now. Every change is kept under Latest movements, with who made it.
                        </p>
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
