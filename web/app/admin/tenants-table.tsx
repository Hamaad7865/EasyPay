"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, ShoppingBag, UtensilsCrossed } from "lucide-react";
import { fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../backoffice/table-kit";
import { Wait } from "../backoffice/busy";
import { cap } from "./bits";

// One restaurant as the list shows it. The dates come ready to read, with the
// moment itself beside them to sort by.
export type TenantLine = {
  id: string;
  code: string;
  name: string;
  type: string;
  plan: string;
  active: boolean;
  reason: string | null;
  stores: number;
  logins: number;
  tills: number;
  lastSale: number | null;
  lastSaleShown: string;
  created: number;
  createdShown: string;
};

const STATUS = [
  ["", "All"],
  ["active", "Active"],
  ["suspended", "Suspended"],
] as const;
const TYPE = [
  ["", "All"],
  ["restaurant", "Restaurants"],
  ["retail", "Retail"],
] as const;

// Every restaurant as one table, on the back office's list kit. The box
// finds one by its name, by the id its owner quotes, by its plan or by why it
// was suspended; a line leads to the restaurant's own page.
export function TenantsTable({ rows, start }: { rows: TenantLine[]; start: Start }) {
  const t = useTable("/admin", start);
  const status = t.get("status");
  const type = t.get("type");
  const hay = useMemo(() => new Map(rows.map((r) => [r.id, fold([r.name, r.code, r.type, r.plan, r.reason ?? ""].join(" "))])), [rows]);
  const byName = (a: TenantLine, b: TenantLine) => a.name.localeCompare(b.name);
  const shown = t.sorted(
    rows.filter((r) => (!status || (status === "active") === r.active) && (!type || r.type === type) && t.finds(hay.get(r.id)!)),
    {
      name: byName,
      plan: (a, b) => a.plan.localeCompare(b.plan) || byName(a, b),
      stores: (a, b) => a.stores - b.stores || byName(a, b),
      logins: (a, b) => a.logins - b.logins || byName(a, b),
      tills: (a, b) => a.tills - b.tills || byName(a, b),
      last: (a, b) => (a.lastSale ?? 0) - (b.lastSale ?? 0),
      created: (a, b) => a.created - b.created,
    },
    { last: (r) => r.lastSale == null },
  );

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All restaurants</h2>
          <p>
            {shown.length !== rows.length ? `${shown.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "restaurant" : "restaurants"}, the newest first unless
            sorted.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search name, ID, plan" label="Search restaurants" />
      </div>
      <div className="table-filters">
        <Seg t={t} name="status" label="Status" options={STATUS} />
        <Seg t={t} name="type" label="Type" options={TYPE} />
      </div>
      <div className="adm-scroll wide">
        <table className="adm-nowrap">
          <thead>
            <tr>
              <SortTh t={t} k="name" label="Restaurant" />
              <SortTh t={t} k="plan" label="Plan" />
              <th>Status</th>
              <SortTh t={t} k="stores" label="Stores" num />
              <SortTh t={t} k="logins" label="Logins" num />
              <SortTh t={t} k="tills" label="Tills" num />
              <SortTh t={t} k="last" label="Last sale" />
              <SortTh t={t} k="created" label="Created" />
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={9} what="restaurant" filters={["status", "type"]} />}
            {shown.map((r) => {
              const Kind = r.type === "retail" ? ShoppingBag : UtensilsCrossed;
              const href = `/admin/tenants/${r.id}`;
              return (
                <tr key={r.id}>
                  <td>
                    <div className="adm-who">
                      <span className="ico" aria-hidden="true">
                        <Kind strokeWidth={1.8} />
                      </span>
                      <span>
                        <Link href={href} className="adm-name">
                          {r.name}
                          <Wait />
                        </Link>
                        <span className="sub">
                          {cap(r.type)} · {r.code}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>{cap(r.plan)}</td>
                  <td>
                    <span className={r.active ? "badge green" : "badge red"}>{r.active ? "Active" : "Suspended"}</span>
                    {r.reason && (
                      <span className="sub clip-note" title={r.reason}>
                        {r.reason}
                      </span>
                    )}
                  </td>
                  <td className="num">{r.stores}</td>
                  <td className="num">{r.logins}</td>
                  <td className="num">{r.tills}</td>
                  <td>{r.lastSale == null ? <span className="muted">Never</span> : r.lastSaleShown}</td>
                  <td>{r.createdShown}</td>
                  <td>
                    <div className="row-actions">
                      <Link href={href} className="go" aria-label={`Open ${r.name}`}>
                        Open
                        <ArrowRight aria-hidden="true" />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
