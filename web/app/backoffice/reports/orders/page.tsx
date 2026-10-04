import { Fragment } from "react";
import { ClipboardList } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { args, canView, clock, filters, fmtQty, lists, RECEIPTS } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters, Stat } from "../parts";

const LIMIT = 300;

type Head = {
  id: string; number: string; type: string; at: string; subtotal: string; discount_total: string; tax_total: string; rounding: string;
  total: string; needs_review: boolean; order_name: string | null; covers: number | null; note: string | null;
  cashier: string | null; waiter: string | null; dining: string | null; table_name: string | null; refund_number: string | null;
};
type Line = { receipt_id: string; name: string; unit_price: string; qty: number; mods: string | null; mod_total: string; tax: string | null };
type Pay = { receipt_id: string; name: string | null; was: string | null; amount: string; tendered: string | null; change: string; reference: string | null };
type Disc = { receipt_id: string; name: string; amount: string };

export default async function OrderDetails({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => {
    const l = await lists(c, ctx.tenantId);
    const f = filters(sp, l.tz);
    if (!(await canView(c, ctx.employeeId))) return { l, f, ok: false as const };
    const heads = (
      await c.query(
        `with r as (${RECEIPTS})
         select r.id, r.number, r.type, r.at, r.subtotal, r.discount_total, r.tax_total, r.rounding, r.total, r.needs_review,
                r.order_name, r.covers, r.note, e.name as cashier, w.name as waiter, o.name as dining, tb.name as table_name,
                (select x.number from receipts x where x.tenant_id = $1 and x.id = r.refund_of) as refund_number
           from r
           left join employees e on e.tenant_id = $1 and e.id = r.employee_id
           left join employees w on w.tenant_id = $1 and w.id = r.opened_by
           left join dining_options o on o.tenant_id = $1 and o.id = r.dining_option_id
           left join tables tb on tb.tenant_id = $1 and tb.id = r.table_id
          where ($7::uuid is null or exists (select 1 from receipt_payments_effective p
                   where p.tenant_id = $1 and p.receipt_id = r.id and p.payment_type_id = $7::uuid))
          order by r.at desc limit ${LIMIT + 1}`,
        [...args(ctx.tenantId, f), f.payment],
      )
    ).rows as Head[];
    const ids = heads.slice(0, LIMIT).map((h) => h.id);
    const rows = async <T,>(sql: string) => (ids.length ? ((await c.query(sql, [ctx.tenantId, ids])).rows as T[]) : []);
    return {
      l, f, ok: true as const, s: await loadSettings(c, ctx.tenantId), heads,
      lines: await rows<Line>(
        `select rl.receipt_id, rl.name_snapshot as name, rl.unit_price, rl.qty,
                (select string_agg(m.name_snapshot, ', ') from receipt_line_modifiers m where m.tenant_id = $1 and m.receipt_line_id = rl.id) as mods,
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
  });
  const head = <PageHead title="Order details" lede="Every receipt in full: what was ordered, by whom, the discounts, the tax and how it was paid. Open a line to see it all." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const at = clock(d.l.tz);
  const shown = d.heads.slice(0, LIMIT);
  const total = shown.reduce((a, h) => a + (h.type === "refund" ? -1 : 1) * Number(h.total), 0);
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/orders" f={d.f} l={d.l} show={["employee", "payment", "kind"]} />
      {shown.length === 0 ? (
        <Empty icon={ClipboardList} title="No receipts in these days">Pick other dates, or clear the filters.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Receipts shown" value={String(shown.length)} note={d.heads.length > LIMIT ? `the latest ${LIMIT}; narrow the dates to see the rest` : undefined} />
            <Stat label="Sales" value={String(shown.filter((h) => h.type === "sale").length)} />
            <Stat label="Refunds" value={String(shown.filter((h) => h.type === "refund").length)} />
            <Stat label="Total" value={m(total)} />
          </div>
          {shown.map((h) => {
            const refund = h.type === "refund";
            const order = h.order_name ?? (h.table_name ? `Table ${h.table_name}` : h.dining ?? "Direct sale");
            return (
              <details key={h.id} className="card flush" style={{ marginBottom: 10 }}>
                <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
                  <div>
                    <h2>{h.number} <span className="muted" style={{ fontWeight: 400 }}>· {order}</span></h2>
                    <p>{at(h.at)}{h.cashier ? ` · ${h.cashier}` : ""}{h.dining ? ` · ${h.dining}` : ""}</p>
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
                        {d.lines.filter((x) => x.receipt_id === h.id).map((x, i) => (
                          <tr key={i}>
                            <td>{x.name}{x.mods && <span className="sub">{x.mods}</span>}{x.tax && <span className="sub">{x.tax}</span>}</td>
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
                        {d.discs.filter((x) => x.receipt_id === h.id).map((x, i) => (<Fragment key={i}><dt>Discount: {x.name}</dt><dd>-{m(x.amount)}</dd></Fragment>))}
                        <dt>Tax</dt><dd>{m(h.tax_total)}</dd>
                        {Number(h.rounding) !== 0 && (<><dt>Rounding</dt><dd>{m(h.rounding)}</dd></>)}
                        <dt className="total">Total</dt><dd className="total">{m(h.total)}</dd>
                        {d.pays.filter((x) => x.receipt_id === h.id).map((x, i) => (
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
          })}
        </>
      )}
    </div>
  );
}
