import { Fragment } from "react";
import type { PoolClient } from "pg";
import { fmtQty } from "@/lib/report";

// A receipt in full, as the Orders report and a customer's history draw it:
// what was ordered, the discounts, the tax and how it was paid, in a card
// that opens. Each page reads its own receipts; their parts are read here.

export type ReceiptHead = {
  id: string; number: string; type: string; at: string; subtotal: string; discount_total: string; tax_total: string; rounding: string;
  total: string; needs_review: boolean; order_name: string | null; covers: number | null; note: string | null;
  cashier: string | null; waiter: string | null; dining: string | null; table_name: string | null; refund_number: string | null;
};
type Line = {
  receipt_id: string; name: string; unit_price: string; qty: number; mods: string | null; mod_total: string; tax: string | null;
  // a shop's line that was discounted, or charged a price typed for this sale: what it was listed at, and who allowed it
  list_price: string | null; price_kind: "discount" | "override" | null; price_label: string | null; price_by: string | null;
};
type Pay = { receipt_id: string; name: string | null; was: string | null; amount: string; tendered: string | null; change: string; reference: string | null };
type Disc = { receipt_id: string; name: string; amount: string };
export type ReceiptParts = { lines: Line[]; pays: Pay[]; discs: Disc[] };

export async function receiptParts(c: PoolClient, tenantId: string, ids: string[]): Promise<ReceiptParts> {
  const rows = async <T,>(sql: string) => (ids.length ? ((await c.query(sql, [tenantId, ids])).rows as T[]) : []);
  return {
    lines: await rows<Line>(
      `select rl.receipt_id, rl.name_snapshot as name, rl.unit_price, rl.qty, rl.list_price, rl.price_kind, rl.price_label,
              (select e.name from ticket_lines tl join employees e on e.tenant_id = $1 and e.id = tl.price_by
                where tl.tenant_id = $1 and tl.id = rl.ticket_line_id and rl.price_kind is not null) as price_by,
              (select string_agg(case when m.qty > 1 then m.qty || ' × ' || m.name_snapshot else m.name_snapshot end, ', ')
                 from receipt_line_modifiers m where m.tenant_id = $1 and m.receipt_line_id = rl.id) as mods,
              coalesce((select sum(m.price) from receipt_line_modifiers m where m.tenant_id = $1 and m.receipt_line_id = rl.id), 0) as mod_total,
              (select string_agg(x.name_snapshot, ', ') from receipt_line_taxes x where x.tenant_id = $1 and x.receipt_line_id = rl.id) as tax
         from receipt_lines rl where rl.tenant_id = $1 and rl.receipt_id = any($2::uuid[]) order by rl.created_at, rl.id`,
    ),
    pays: await rows<Pay>(
      `select p.receipt_id, pt.name, case when p.payment_type_id <> p.original_payment_type_id then old.name end as was,
              p.amount, p.tendered, p.change, p.reference
         from receipt_payments_effective p
         left join payment_types pt on pt.tenant_id = $1 and pt.id = p.payment_type_id
         left join payment_types old on old.tenant_id = $1 and old.id = p.original_payment_type_id
        where p.tenant_id = $1 and p.receipt_id = any($2::uuid[])`,
    ),
    discs: await rows<Disc>(`select receipt_id, name_snapshot as name, amount from receipt_discounts where tenant_id = $1 and receipt_id = any($2::uuid[])`),
  };
}

// `more`: what a page adds to the line under the number (a customer's history: the store, the points)
export function ReceiptCard({ h, parts, m, at, more = [] }: {
  h: ReceiptHead; parts: ReceiptParts; m: (v: string | number) => string; at: (v: string) => string; more?: string[];
}) {
  const refund = h.type === "refund";
  const order = h.order_name ?? (h.table_name ? `Table ${h.table_name}` : h.dining ?? "Direct sale");
  return (
    <details className="card flush" style={{ marginBottom: 10 }}>
      <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
        <div>
          <h2>{h.number} <span className="muted" style={{ fontWeight: 400 }}>· {order}</span></h2>
          <p>{[at(h.at), h.cashier, h.dining, ...more].filter(Boolean).join(" · ")}</p>
        </div>
        <span className="row-actions">
          {h.needs_review && <span className="badge amber">To check</span>}
          <span className={"badge " + (refund ? "red" : "green")}>{refund ? "Refund" : "Sale"}</span>
          <strong style={{ minWidth: 96, textAlign: "right" }}>{refund ? "-" : ""}{m(h.total)}</strong>
        </span>
      </summary>
      <div className="card-body">
        <div className="grid-2">
          <table>
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {parts.lines.filter((x) => x.receipt_id === h.id).map((x, i) => (
                <tr key={i}>
                  <td>
                    {x.name}{x.mods && <span className="sub">{x.mods}</span>}{x.tax && <span className="sub">{x.tax}</span>}
                    {x.price_kind && x.list_price != null && (
                      <span className="sub">
                        {x.price_kind === "discount" ? (x.price_label ?? "Discount") : "Price typed for this sale"}: listed at {m(x.list_price)}
                        {x.price_by ? `, allowed by ${x.price_by}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="num">{fmtQty(x.qty)}</td>
                  <td className="num">{m(x.unit_price)}</td>
                  <td className="num">{m(Math.round((Number(x.unit_price) * x.qty) / 1000) + Number(x.mod_total))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <dl className="kv">
              <dt>Subtotal</dt><dd>{m(h.subtotal)}</dd>
              {parts.discs.filter((x) => x.receipt_id === h.id).map((x, i) => (<Fragment key={i}><dt>Discount: {x.name}</dt><dd>-{m(x.amount)}</dd></Fragment>))}
              <dt>Tax</dt><dd>{m(h.tax_total)}</dd>
              {Number(h.rounding) !== 0 && (<><dt>Rounding</dt><dd>{m(h.rounding)}</dd></>)}
              <dt className="total">Total</dt><dd className="total">{m(h.total)}</dd>
              {parts.pays.filter((x) => x.receipt_id === h.id).map((x, i) => (
                <Fragment key={i}>
                  <dt>{refund ? "Paid back by" : "Paid by"} {x.name ?? "unknown"}{x.was ? ` (corrected from ${x.was})` : ""}{x.reference ? ` · ref ${x.reference}` : ""}</dt>
                  <dd>{m(x.amount)}{x.tendered && Number(x.change) > 0 ? ` (given ${m(x.tendered)}, change ${m(x.change)})` : ""}</dd>
                </Fragment>
              ))}
            </dl>
            <p className="muted" style={{ marginTop: 14 }}>
              {h.waiter ? `Waiter: ${h.waiter}. ` : ""}{h.covers ? `Covers: ${h.covers}. ` : ""}{h.note ? `Remark: ${h.note}. ` : ""}
              {refund && h.refund_number ? `Refund of ${h.refund_number}.` : ""}
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}
