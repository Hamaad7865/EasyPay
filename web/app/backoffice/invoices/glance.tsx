"use client";

import Link from "next/link";
import { AlertTriangle, Plus } from "lucide-react";
import { money } from "@/lib/settings";
import { stateOf, STATE_TONE, STATE_WORDS } from "@/lib/invoice-money";
import type { Glance } from "./data";

// The customer beside their invoice, in two cards: what they owe in all (bills on account from the tablet and
// invoices, shown together), what is late and their last invoices; then what they buy most, with the price they
// last paid. `onAdd` puts one of those on the invoice; an issued invoice's page has none.
export function GlanceCard({ id, g, today, decimals, shop, onAdd, loading }: {
  id: string | null;
  g: Glance | null;
  today: string;
  decimals: number;
  shop: boolean;
  onAdd?: (o: Glance["often"][number]) => void;
  loading?: boolean;
}) {
  const rs = (c: number) => money(c, decimals);
  if (!g) {
    return (
      <div className="inv-rail">
        <aside className="card inv-glance">
          <h2 className="inv-label">The customer</h2>
          <p className="muted inv-small">{loading ? "Looking them up…" : "Pick a customer to see what they owe, what is late and their last invoices."}</p>
        </aside>
        <aside className="card inv-glance">
          <h2 className="inv-label">Usually buys</h2>
          <p className="muted inv-small">{loading ? "Looking them up…" : `Pick a customer to see what they buy most${onAdd ? ", and add it in one click" : ""}.`}</p>
        </aside>
      </div>
    );
  }
  const owed = g.billsOwed + g.invoicesOwed;
  const late = g.billsOverdue + g.invoicesOverdue;
  return (
    <div className="inv-rail" aria-busy={loading || undefined}>
      <aside className="card inv-glance">
        <h2 className="inv-label">The customer</h2>
        <p className="inv-glance-name">{g.name}</p>
        {(g.phone || g.email) && <p className="muted inv-small">{[g.phone, g.email].filter(Boolean).join(" · ")}</p>}
        <div className="inv-owes-big">
          <span>Owes in all</span>
          <strong className={"inv-mono" + (late > 0 ? " inv-late-ink" : "")}>{rs(owed)}</strong>
        </div>
        {late > 0 && (
          <p className="note danger inv-glance-late" role="alert">
            <AlertTriangle aria-hidden="true" />
            <span>
              {rs(late)} overdue
              {g.overdueCount > 0 && ` · ${g.overdueCount === 1 ? "1 invoice" : `${g.overdueCount} invoices`} past their due day`}
            </span>
          </p>
        )}
        <dl className="kv inv-glance-kv">
          <dt className="inv-sub">On invoices</dt>
          <dd className="inv-sub">{rs(g.invoicesOwed)}</dd>
          <dt className="inv-sub">Bills on account</dt>
          <dd className="inv-sub">{rs(g.billsOwed)}</dd>
        </dl>
        {g.last.length > 0 && (
          <>
            <h3 className="inv-glance-h">Last invoices</h3>
            <ul className="inv-glance-list">
              {g.last.map((i) => {
                const s = stateOf({ status: "issued", total: i.total, paid: i.paid, due_on: i.due }, today);
                return (
                  <li key={i.id}>
                    <Link href={`/backoffice/invoices/${i.id}`}>{i.number}</Link>
                    <span className="muted">{i.issued_on}</span>
                    <span className="inv-num">{rs(i.total)}</span>
                    <span className={STATE_TONE[s]}>{STATE_WORDS[s]}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {id && (
          <p className="inv-small inv-glance-more">
            <Link href={`/backoffice/customers/${id}`}>Their history</Link>
          </p>
        )}
      </aside>
      <aside className="card inv-glance">
        <h2 className="inv-label">Usually buys</h2>
        {g.often.length === 0 ? (
          <p className="muted inv-small">Nothing bought yet, on the tills or on invoices, in the last year.</p>
        ) : (
          <>
            <ul className="inv-often">
              {g.often.map((o) => (
                <li key={`${o.item_id}|${o.variant_id ?? ""}`}>
                  {onAdd ? (
                    <button type="button" className="inv-often-add" onClick={() => onAdd(o)} title={`Add ${o.name} at ${rs(o.last_price)}`}>
                      <Plus aria-hidden="true" />
                      <span className="inv-often-name">{o.name}</span>
                      <span className="inv-often-was">
                        {rs(o.last_price)} last, {o.last_on} · {o.times === 1 ? "once" : `${o.times} times`}
                      </span>
                    </button>
                  ) : (
                    <span className="inv-often-add inv-often-still">
                      <span className="inv-often-name">{o.name}</span>
                      <span className="inv-often-was">
                        {rs(o.last_price)} last, {o.last_on} · {o.times === 1 ? "once" : `${o.times} times`}
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {onAdd && <p className="muted inv-small inv-glance-more">A click adds it at the price they last paid. From the last year of their {shop ? "sales" : "bills"} and invoices.</p>}
          </>
        )}
      </aside>
    </div>
  );
}
