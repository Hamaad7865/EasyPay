"use client";

import { useMemo } from "react";
import { Back, Chev, fold, NoMatch, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Submit } from "../busy";

export type Supplier = { id: string; name: string; contact: string | null; phone: string | null; email: string | null; address: string | null; note: string | null; products: number };
type Action = (f: FormData) => Promise<void>;

// The suppliers as one table: who they are, who to speak to and how to reach
// them, and how many products name them. The box finds one by any of that as
// you type; tapping a line opens it to change or remove them.
export function SuppliersTable({ rows, start, save, remove }: { rows: Supplier[]; start: Start; save: Action; remove: Action }) {
  const t = useTable("/backoffice/suppliers", start);
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold([r.name, r.contact ?? "", r.phone ?? "", r.email ?? "", r.address ?? "", r.note ?? ""].join(" "))])), [rows]);
  const shown = t.sorted(
    rows.filter((r) => t.finds(hay.get(r.id)!)),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      products: (a, b) => a.products - b.products || a.name.localeCompare(b.name),
    },
  );

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All suppliers</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "supplier" : "suppliers"}. Tap one to change their details.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search name, contact, phone, email" label="Search suppliers" />
      </div>
      <div className="table-scroll">
        <table className="rows-open">
          <thead>
            <tr>
              <th />
              <SortTh t={t} k="name" label="Supplier" />
              <th>Contact</th>
              <th>Phone</th>
              <th>Email</th>
              <SortTh t={t} k="products" label="Products" num />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={6} what="supplier" />}
            {shown.map((r) => {
              const on = t.isOpen(r.id);
              return [
                <tr key={r.id} className={on ? "row on" : "row"} onClick={() => t.toggle(r.id)}>
                  <td>
                    <Chev open={on} name={r.name} onClick={() => t.toggle(r.id)} />
                  </td>
                  <td className="strong">{r.name}</td>
                  <td>{r.contact ?? <span className="muted">None</span>}</td>
                  <td>{r.phone ?? <span className="muted">None</span>}</td>
                  <td>{r.email ?? <span className="muted">None</span>}</td>
                  <td className="num">{r.products || <span className="muted">None</span>}</td>
                </tr>,
                on && (
                  <tr key={r.id + "-open"} className="open-body">
                    <td colSpan={6}>
                      <div className="open-panel">
                        <form action={save} className="bo-toolbar" style={{ margin: 0 }}>
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} id={r.id} />
                          <input name="name" defaultValue={r.name} required maxLength={120} aria-label="Name" placeholder="Name" style={{ fontWeight: 600 }} />
                          <input name="contact" defaultValue={r.contact ?? ""} maxLength={120} aria-label="Contact person" placeholder="Contact person" />
                          <input name="phone" defaultValue={r.phone ?? ""} maxLength={40} aria-label="Phone" placeholder="Phone" inputMode="tel" />
                          <input name="email" defaultValue={r.email ?? ""} maxLength={120} aria-label="Email" placeholder="Email" inputMode="email" />
                          <input name="address" defaultValue={r.address ?? ""} maxLength={200} aria-label="Address" placeholder="Address" style={{ flex: "1 1 220px" }} />
                          <input name="note" defaultValue={r.note ?? ""} maxLength={200} aria-label="Note" placeholder="Note (delivery days, minimum order)" style={{ flex: "1 1 220px" }} />
                          <Submit className="btn-sm">
                            Save
                          </Submit>
                        </form>
                        <form action={remove} className="open-remove">
                          <input type="hidden" name="id" value={r.id} />
                          <Back t={t} />
                          <span className="muted">Removing a supplier keeps their products; each then shows no supplier.</span>
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
