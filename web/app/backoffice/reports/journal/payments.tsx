"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

// The journal's Payments, as Carfectionist has it: a line for each way the
// money came in, closed, with an arrow that opens it to the sales behind it,
// then the total. Under the total, only when there is some: money paid on
// earlier sales (in the total already) and what is still on account (not in
// it). The page works out the figures and hands them over written.

export type Sale = { id: string; number: string; says: string; amount: string };
export type Line = {
  label: string;
  n?: number;
  amount: string;
  note?: string;
  tone?: "muted" | "owed";
  before?: { amount: string; change: string };
  sales: Sale[];
};

export function Payments({ methods, total, after, compared }: { methods: Line[]; total: Line; after: Line[]; compared: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const before = (l: Line) => (compared ? <td className="num muted">{l.before?.amount} <span className="sub">{l.before?.change}</span></td> : null);
  const line = (l: Line) => {
    const opens = l.sales.length > 0;
    const on = open.has(l.label);
    return (
      <Fragment key={l.label}>
        <tr className={[opens ? "row" : "", on ? "on" : "", l.tone ?? ""].filter(Boolean).join(" ") || undefined} onClick={opens ? () => toggle(l.label) : undefined}>
          <td>
            <span className="lead">
              {opens ? (
                <button type="button" className="chev" aria-expanded={on} aria-label={(on ? "Close " : "Open ") + l.label} onClick={(e) => { e.stopPropagation(); toggle(l.label); }}>
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : (
                <span className="chev" />
              )}
              <span className="name">{l.label}</span>
              {opens && <span className="count">({l.sales.length} {l.sales.length === 1 ? "sale" : "sales"})</span>}
            </span>
            {l.note && <span className="pay-note">{l.note}</span>}
          </td>
          <td className="num">{l.n ?? ""}</td>
          <td className="num amount">{l.amount}</td>
          {before(l)}
        </tr>
        {/* written while closed too, hidden, so a line opens at once */}
        {l.sales.map((s) => (
          <tr key={s.id} className="sale" hidden={!on}>
            <td>
              <Link href={`/backoffice/receipts?q=${encodeURIComponent(s.number)}`}>{s.number}</Link>
              {s.says && ` · ${s.says}`}
            </td>
            <td />
            <td className="num">{s.amount}</td>
            {compared && <td />}
          </tr>
        ))}
      </Fragment>
    );
  };
  return (
    <table className="pay-open">
      <thead>
        <tr><th>Payment method</th><th className="num">Quantity</th><th className="num">Amount</th>{compared && <th className="num">Before</th>}</tr>
      </thead>
      <tbody>
        {methods.length === 0 && <tr><td colSpan={compared ? 4 : 3} className="muted">No money was taken in these days.</td></tr>}
        {methods.map(line)}
      </tbody>
      <tbody>
        <tr className="total">
          <td>{total.label}</td>
          <td />
          <td className="num">{total.amount}</td>
          {before(total)}
        </tr>
        {after.map(line)}
      </tbody>
    </table>
  );
}
