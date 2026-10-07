"use client";

import { useMemo } from "react";
import { Back, Chev, fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Submit } from "../busy";

export type Customer = { id: string; name: string; phone: string | null; email: string | null; note: string | null; orders: number; spent: number; spent_shown: string };
type Action = (f: FormData) => Promise<void>;

const SEEN = [
  ["", "All"],
  ["ordered", "Have ordered"],
  ["never", "Never ordered"],
] as const;

// The customers as one table: who they are, how to reach them, and what they
// have ordered. The box finds one by name, phone, email or note as you type;
// tapping a line opens it to change or remove them.
export function CustomersTable({ rows, capped, start, save, remove }: { rows: Customer[]; capped: boolean; start: Start; save: Action; remove: Action }) {
  const t = useTable("/backoffice/customers", start);
  const seen = t.get("seen");
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold([r.name, r.phone ?? "", r.email ?? "", r.note ?? ""].join(" "))])), [rows]);
  // a phone number is found whatever spaces it was typed or stored with
  const digits = useMemo(() => new Map(rows.map((r) => [r.id, (r.phone ?? "").replace(/\D/g, "")])), [rows]);
  const typed = t.get("q").replace(/\D/g, "");
  const byPhone = typed.length >= 3 && /^[\d\s+()-]+$/.test(t.get("q").trim());
  const shown = t.sorted(
    rows.filter(
      (r) => (!seen || (seen === "ordered" ? r.orders > 0 : seen === "never" ? r.orders === 0 : true)) && (byPhone ? digits.get(r.id)!.includes(typed) : t.finds(hay.get(r.id)!)),
    ),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      orders: (a, b) => a.orders - b.orders || a.name.localeCompare(b.name),
      spent: (a, b) => a.spent - b.spent || a.name.localeCompare(b.name),
    },
  );

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All customers</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "customer" : "customers"}
            {capped && " (the first of a longer list, by name)"}. Tap one to change their details.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search name, phone, email, note" label="Search customers" />
      </div>
      <div className="table-filters">
        <Seg t={t} name="seen" label="Show" options={SEEN} />
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              <SortTh t={t} k="name" label="Name" />
              <th>Phone</th>
              <th>Email</th>
              <th>Note</th>
              <SortTh t={t} k="orders" label="Orders" num />
              <SortTh t={t} k="spent" label="Spent" num />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={7} what="customer" filters={["seen"]} />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={r.name} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong">{r.name}</td>
                  <td>{r.phone ?? <span className="muted">None</span>}</td>
                  <td>{r.email ?? <span className="muted">None</span>}</td>
                  <td className="clip-note">{r.note ?? <span className="muted">None</span>}</td>
                  <td className="num">{r.orders || <span className="muted">None</span>}</td>
                  <td className="num strong">{r.orders > 0 || r.spent !== 0 ? r.spent_shown : <span className="muted">Nothing</span>}</td>
                </tr>,
                on && (
                  <tr key={r.id + "-open"} className="open-body">
                    <td colSpan={7}>
                      <div className="open-panel">
                        <form id={"c" + r.id} action={save} className="bo-toolbar" style={{ margin: 0 }}>
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} id={r.id} />
                          <input name="name" defaultValue={r.name} required maxLength={120} aria-label="Name" placeholder="Name" style={{ fontWeight: 600 }} />
                          <input name="phone" defaultValue={r.phone ?? ""} maxLength={40} aria-label="Phone" placeholder="Phone" inputMode="tel" />
                          <input name="email" defaultValue={r.email ?? ""} maxLength={120} aria-label="Email" placeholder="Email" inputMode="email" />
                          <input name="note" defaultValue={r.note ?? ""} maxLength={200} aria-label="Note" placeholder="Note (allergies, what they like)" style={{ flex: "1 1 220px" }} />
                          <Submit className="btn-sm">
                            Save
                          </Submit>
                        </form>
                        <form action={remove} className="open-remove">
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} />
                          <span className="muted">Removing a customer keeps the orders and receipts they were on.</span>
                          <Submit className="btn-link danger">
                            Remove {r.name}
                          </Submit>
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
