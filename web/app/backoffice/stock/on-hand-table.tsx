"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ADJUST_REASONS, STATUS_LABEL, type StockStatus } from "@/lib/stock";
import { Back, Chev, fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Submit } from "../busy";

// One line of a shop's stock: a product, or one variant of it. Quantities are
// thousandths; the `_shown` fields are the same as people read them. Cost and
// value are null for someone who may not see cost: they never reach the browser.
export type OnHandRow = {
  id: string;
  item: string;
  variant_id: string | null;
  name: string;
  variant: string | null;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  supplier_id: string | null;
  supplier: string | null;
  qty: number;
  qty_shown: string;
  status: StockStatus;
  reorder: number | null;
  reorder_shown: string | null;
  sold30: number;
  sold_shown: string;
  cost_shown: string | null;
  value: number | null;
  value_shown: string | null;
};
type Action = (f: FormData) => Promise<void>;

const SHOW = [
  ["", "All"],
  ["low", "Low"],
  ["out", "Out"],
  ["negative", "Below zero"],
] as const;
const TONE: Record<StockStatus, string> = { negative: "badge red", out: "badge red", low: "badge amber", ok: "badge green" };

// What the shop holds, as one table. The box finds a line by name, SKU or a
// scanned barcode; tapping a line opens it to take stock out, or put found
// stock back, with a reason.
export function OnHandTable({
  rows, suppliers, start, adjust, mayAdjust, showCost,
}: {
  rows: OnHandRow[];
  suppliers: [string, string][];
  start: Start;
  adjust: Action;
  mayAdjust: boolean;
  showCost: boolean;
}) {
  const t = useTable("/backoffice/stock", start);
  const show = t.get("show");
  const supplier = t.get("supplier");
  const hay = useMemo(
    () => new Map(rows.map((r) => [r.id, fold([r.name, r.variant ?? "", r.sku ?? "", r.barcode ?? "", r.category ?? "", r.supplier ?? ""].join(" "))])),
    [rows],
  );
  const shown = t.sorted(
    rows.filter((r) => (!show || r.status === show) && (!supplier || r.supplier_id === supplier) && t.finds(hay.get(r.id)!)),
    {
      name: (a, b) => a.name.localeCompare(b.name) || (a.variant ?? "").localeCompare(b.variant ?? ""),
      stock: (a, b) => a.qty - b.qty || a.name.localeCompare(b.name),
      value: (a, b) => (a.value ?? 0) - (b.value ?? 0) || a.name.localeCompare(b.name),
      reorder: (a, b) => (a.reorder ?? 0) - (b.reorder ?? 0) || a.name.localeCompare(b.name),
      sold: (a, b) => a.sold30 - b.sold30 || a.name.localeCompare(b.name),
    },
    { reorder: (r) => r.reorder === null },
  );
  const cols = showCost ? 9 : 7;

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>Products and variants</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "line" : "lines"}. Tap one to adjust it or see its movements.
          </p>
        </div>
        <TableSearch t={t} placeholder="Name, SKU or scan a barcode" label="Search stock" />
      </div>
      <div className="table-filters">
        <Seg t={t} name="show" label="Show" options={SHOW} />
        {suppliers.length > 0 && (
          <select value={suppliers.some(([id]) => id === supplier) ? supplier : ""} onChange={(e) => t.set("supplier", e.target.value)} aria-label="Supplier">
            <option value="">All suppliers</option>
            {suppliers.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              <SortTh t={t} k="name" label="Product" />
              <th>Variant</th>
              <SortTh t={t} k="stock" label="On hand" num />
              {showCost && <th className="num">Avg cost</th>}
              {showCost && <SortTh t={t} k="value" label="Value" num />}
              <SortTh t={t} k="reorder" label="Reorder at" num />
              <SortTh t={t} k="sold" label="Sold, 30 days" num />
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={cols} what="line" filters={["show", "supplier"]} />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              const title = r.name + (r.variant ? ", " + r.variant : "");
              const moves = `/backoffice/stock-movements?item=${r.item}${r.variant_id ? "&variant=" + r.variant_id : ""}`;
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={title} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong">{r.name}</td>
                  <td>{r.variant ?? <span className="muted">One size</span>}</td>
                  <td className="num strong" style={r.qty <= 0 ? { color: "var(--red)" } : undefined}>{r.qty_shown}</td>
                  {showCost && <td className="num">{r.cost_shown}</td>}
                  {showCost && <td className="num">{r.value_shown}</td>}
                  <td className="num">{r.reorder_shown ?? <span className="muted">Not set</span>}</td>
                  <td className="num">{r.sold30 !== 0 ? r.sold_shown : <span className="muted">None</span>}</td>
                  <td>
                    <span className={TONE[r.status]}>{STATUS_LABEL[r.status]}</span>
                  </td>
                </tr>,
                on && (
                  <tr key={r.id + "-open"} className="open-body">
                    <td colSpan={cols}>
                      <div className="open-panel">
                        {mayAdjust ? (
                          <form action={adjust} className="bo-toolbar" style={{ margin: 0 }}>
                            <input type="hidden" name="item" value={r.item} />
                            <input type="hidden" name="variant" value={r.variant_id ?? ""} />
                            <Back t={t} id={r.id} />
                            <select name="reason" defaultValue="damaged" aria-label="Reason">
                              {ADJUST_REASONS.map(([code, label]) => (
                                <option key={code} value={code}>
                                  {label}
                                </option>
                              ))}
                            </select>
                            <input name="qty" required className="narrow" inputMode="decimal" placeholder="Quantity" aria-label={`Quantity for ${title}`} />
                            <input name="note" maxLength={120} placeholder="Note, for example what happened" aria-label="Note" style={{ flex: "1 1 220px" }} />
                            <Submit className="btn-sm">Save adjustment</Submit>
                            <Link href={moves}>See movements</Link>
                          </form>
                        ) : (
                          <p style={{ margin: 0 }}>
                            <Link href={moves}>See movements</Link>
                          </p>
                        )}
                        <p className="muted open-hint">
                          {r.qty_shown} on hand now.{" "}
                          {mayAdjust ? "To add stock, receive a delivery, so its cost is recorded." : "Your role cannot adjust stock."}
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
