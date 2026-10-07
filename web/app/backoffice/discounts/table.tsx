"use client";

import { useMemo } from "react";
import { Back, Chev, fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Submit } from "../busy";

export type Discount = {
  id: string;
  name: string;
  type: "percent" | "amount";
  // a whole percentage, or cents; `shown` is how the till words it ("10%", "Rs 50.00")
  value: number;
  shown: string;
  requires_approval: boolean;
  used: number;
  taken: number;
  taken_shown: string;
};
type Action = (f: FormData) => Promise<void>;

const WHO = [
  ["", "All"],
  ["manager", "Needs a manager"],
  ["anyone", "Anyone allowed"],
] as const;

// The discounts as one table: what each takes off, who may give it and how
// much it has given away. Tapping a line opens it to change or remove it.
export function DiscountsTable({ rows, start, save }: { rows: Discount[]; start: Start; save: Action }) {
  const t = useTable("/backoffice/discounts", start);
  const who = t.get("who");
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold(`${r.name} ${r.shown} ${r.requires_approval ? "manager" : ""}`)])), [rows]);
  const shown = t.sorted(
    rows.filter((r) => (!who || (who === "manager" ? r.requires_approval : who === "anyone" ? !r.requires_approval : true)) && t.finds(hay.get(r.id)!)),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      used: (a, b) => a.used - b.used || a.name.localeCompare(b.name),
      taken: (a, b) => a.taken - b.taken || a.name.localeCompare(b.name),
    },
  );

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All discounts</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "discount" : "discounts"}. Tap one to change it.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search discounts" label="Search discounts" />
      </div>
      <div className="table-filters">
        <Seg t={t} name="who" label="Who may give it" options={WHO} />
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              <SortTh t={t} k="name" label="Discount" />
              <th>Takes off</th>
              <th>Who may give it</th>
              <SortTh t={t} k="used" label="Times given" num />
              <SortTh t={t} k="taken" label="Given away" num />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={6} what="discount" filters={["who"]} />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={r.name} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong">{r.name}</td>
                  <td>{r.shown}</td>
                  <td>{r.requires_approval ? <span className="badge amber">Needs a manager</span> : <span className="muted">Anyone allowed to discount</span>}</td>
                  <td className="num">{r.used === 0 ? <span className="muted">Never</span> : r.used}</td>
                  <td className="num">{r.used === 0 ? <span className="muted">Nothing</span> : r.taken_shown}</td>
                </tr>,
                on && (
                  <tr key={r.id + "-open"} className="open-body">
                    <td colSpan={6}>
                      <div className="open-panel">
                        <form action={save} className="bo-toolbar" style={{ margin: 0 }}>
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} id={r.id} />
                          <input name="name" defaultValue={r.name} required maxLength={40} aria-label="Name" style={{ fontWeight: 600 }} />
                          <select name="type" defaultValue={r.type} aria-label="Takes off">
                            <option value="percent">A percentage</option>
                            <option value="amount">An amount (Rs)</option>
                          </select>
                          <input name="value" defaultValue={r.type === "percent" ? String(r.value) : (r.value / 100).toString()} className="narrow" inputMode="decimal" required aria-label="How much" />
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" name="requires_approval" defaultChecked={r.requires_approval} />
                            Needs a manager
                          </label>
                          <span className="spacer" />
                          <Submit className="btn-sm">
                            Save
                          </Submit>
                          <Submit name="remove" value="1" className="btn-link danger" formNoValidate>
                            Remove
                          </Submit>
                        </form>
                        <p className="muted open-hint">Receipts it was already given on keep its name and what it took off.</p>
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
