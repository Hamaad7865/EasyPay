"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, ScrollText } from "lucide-react";
import { dayWords, daysLate, type InvoiceState, STATE_TONE, STATE_WORDS, stateOf } from "@/lib/invoice-money";
import { money } from "@/lib/settings";
import { downloadCsv, fold, NoMatch, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { Empty } from "../ui";
import type { ListRow } from "./data";

// The invoices, tab by tab: drafts, the ones not paid yet, partly paid, overdue, paid, all. Where an invoice
// stands is worked out from its payments and its due day (lib/invoice-money.ts stateOf), never stored.

const TABS: [string, string][] = [
  ["", "All"],
  ["draft", "Drafts"],
  ["issued", "Not paid yet"],
  ["part", "Partly paid"],
  ["overdue", "Overdue"],
  ["paid", "Paid"],
];
const PATH = "/backoffice/invoices";

export function InvoiceList({ rows, start, today, many, decimals }: { rows: ListRow[]; start: Start; today: string; many: boolean; decimals: number }) {
  const t = useTable(PATH, start);
  const router = useRouter();
  const rs = (cents: number) => money(cents, decimals);
  const withState = rows.map((r) => ({ ...r, state: stateOf(r, today) as InvoiceState, owed: r.status === "issued" ? r.total - r.paid : 0 }));
  const counts = Object.fromEntries(TABS.map(([k]) => [k, k ? withState.filter((r) => r.state === k).length : withState.length]));
  const tab = TABS.some(([k]) => k === t.get("tab")) ? t.get("tab") : "";
  const shown = t.sorted(
    withState.filter((r) => (!tab || r.state === tab) && t.finds(fold([r.number ?? "draft", r.buyer_name, r.cust_ref ?? "", r.our_ref ?? "", r.branch].join(" ")))),
    {
      number: (a, b) => (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true }),
      customer: (a, b) => a.buyer_name.localeCompare(b.buyer_name),
      date: (a, b) => a.issued_on.localeCompare(b.issued_on),
      due: (a, b) => a.due_on.localeCompare(b.due_on),
      total: (a, b) => a.total - b.total,
      owed: (a, b) => a.owed - b.owed,
    },
  );
  const csv = () =>
    downloadCsv(`invoices-${today}`, [
      ["Number", "Status", ...(many ? ["Branch"] : []), "Customer", "Type", "Their reference", "Our reference", "Date", "Due", "Total", "Paid", "Owed"],
      ...shown.map((r) => [
        r.number ?? "Draft", STATE_WORDS[r.state], ...(many ? [r.branch] : []), r.buyer_name, r.buyer_type, r.cust_ref ?? "", r.our_ref ?? "",
        r.issued_on, r.status === "issued" ? r.due_on : "", r.total / 100, r.paid / 100, r.owed / 100,
      ]),
    ]);

  if (rows.length === 0) {
    return (
      <Empty icon={ScrollText} title="No invoices yet">
        Start one with New invoice. A draft keeps itself as you type; issuing gives it its number.
      </Empty>
    );
  }
  return (
    <section className="card flush">
      <div className="inv-tabs" role="tablist" aria-label="Invoices by where they stand">
        {TABS.map(([k, label]) => (
          <button key={k || "all"} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : undefined} onClick={() => t.set("tab", k)}>
            {label}
            <span className="inv-tab-n">{counts[k]}</span>
          </button>
        ))}
      </div>
      <div className="card-head">
        <TableSearch t={t} placeholder="Number, customer or reference" label="Find an invoice" />
        <button type="button" className="btn-quiet btn-sm" onClick={csv}>
          <Download aria-hidden="true" />
          CSV
        </button>
      </div>
      <div className="table-scroll">
        <table className="inv-list">
          <thead>
            <tr>
              <SortTh t={t} k="number" label="Number" />
              {many && <th>Branch</th>}
              <SortTh t={t} k="customer" label="Customer" />
              <th>Their reference</th>
              <SortTh t={t} k="date" label="Date" />
              <SortTh t={t} k="due" label="Due" />
              <SortTh t={t} k="total" label="Total" num />
              <SortTh t={t} k="owed" label="Owed" num />
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <NoMatch t={t} cols={many ? 9 : 8} what="invoice" filters={["tab"]} />
            ) : (
              shown.map((r) => {
                const late = r.state === "overdue" ? daysLate(r.due_on, today) : 0;
                return (
                  <tr key={r.id} className="inv-list-row" onClick={() => router.push(`${PATH}/${r.id}`)}>
                    <td className="strong inv-list-no">
                      <Link href={`${PATH}/${r.id}`} onClick={(e) => e.stopPropagation()}>
                        {r.number ?? <span className="muted">No number yet</span>}
                      </Link>
                    </td>
                    {many && <td>{r.branch}</td>}
                    <td>
                      {r.buyer_name || <span className="muted">No customer yet</span>}
                      {r.buyer_type !== "B2C" && <span className="cell-sub">{r.buyer_type === "B2B" ? "Business" : "Government"}</span>}
                    </td>
                    <td>{r.cust_ref || <span className="muted">—</span>}</td>
                    <td className="inv-list-day">{dayWords(r.issued_on)}</td>
                    <td className="inv-list-day">{r.status === "issued" ? dayWords(r.due_on) : <span className="muted">—</span>}</td>
                    <td className="num">{rs(r.total)}</td>
                    <td className="num">{r.owed > 0 ? rs(r.owed) : <span className="muted">—</span>}</td>
                    <td>
                      <span className={STATE_TONE[r.state]}>{STATE_WORDS[r.state]}</span>
                      {late > 0 && <span className="cell-sub">{late === 1 ? "1 day late" : `${late} days late`}</span>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
