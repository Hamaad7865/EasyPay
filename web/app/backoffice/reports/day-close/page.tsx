import { CalendarCheck } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { clock, filters, fmtQty, reportStart } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters } from "../parts";

type Close = {
  id: string; number: number; from_time: string | null; closed_at: string; closed_by: string | null; till: string | null;
  totals: { sales: number; refunds: number; gross: number; refunded: number; discounts: number; tax: number };
  payments: { name: string | null; amount: number; n: number }[];
  cats: { name: string | null; qty: number; amount: number }[];
  taxes: { name: string | null; rate_bp: number | null; tax: number }[];
  cash: { in: number; out: number; list: { type: string; amount: number; reason: string | null; who: string | null }[] };
};

// A day closing covers one till from the closing before it (or from its first
// sale) up to the moment it was closed. The figures are worked out from the
// receipts as they are now, so a sale that synced late is included.
const W = `r.tenant_id = dc.tenant_id and r.device_id = dc.device_id and r.deleted_at is null
  and coalesce(r.device_time, r.created_at) > coalesce(dc.from_time, '-infinity'::timestamptz)
  and coalesce(r.device_time, r.created_at) <= dc.closed_at`;
const SQL = `
  select dc.id, dc.number, dc.from_time, dc.closed_at, e.name as closed_by, d.name as till,
         (select json_build_object('sales', count(*) filter (where r.type = 'sale'), 'refunds', count(*) filter (where r.type = 'refund'),
                   'gross', coalesce(sum(r.total) filter (where r.type = 'sale'), 0),
                   'refunded', coalesce(sum(r.total) filter (where r.type = 'refund'), 0),
                   'discounts', coalesce(sum(case when r.type = 'refund' then -r.discount_total else r.discount_total end), 0),
                   'tax', coalesce(sum(case when r.type = 'refund' then -r.tax_total else r.tax_total end), 0))
            from receipts r where ${W}) as totals,
         (select coalesce(json_agg(json_build_object('name', q.name, 'amount', q.amount, 'n', q.n) order by q.amount desc), '[]'::json)
            from (select pt.name, sum(case when r.type = 'refund' then -p.amount else p.amount end) as amount, count(*) as n
                    from receipts r join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                    left join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id
                   where ${W} group by pt.name) q) as payments,
         (select coalesce(json_agg(json_build_object('name', q.name, 'qty', q.qty, 'amount', q.amount) order by q.amount desc), '[]'::json)
            from (select c.name, sum(case when r.type = 'refund' then -rl.qty else rl.qty end) as qty,
                         sum((case when r.type = 'refund' then -1 else 1 end) * (line_amount(rl.unit_price, rl.qty)
                           + coalesce((select sum(m.price) from receipt_line_modifiers m where m.tenant_id = r.tenant_id and m.receipt_line_id = rl.id), 0))) as amount
                    from receipts r join receipt_lines rl on rl.tenant_id = r.tenant_id and rl.receipt_id = r.id
                    left join ticket_lines tl on tl.tenant_id = r.tenant_id and tl.id = rl.ticket_line_id
                    left join items i on i.tenant_id = r.tenant_id and i.id = tl.item_id
                    left join categories c on c.tenant_id = r.tenant_id and c.id = i.category_id
                   where ${W} group by c.name) q) as cats,
         (select json_build_object('in', coalesce(sum(m.amount) filter (where m.type = 'in'), 0),
                   'out', coalesce(sum(m.amount) filter (where m.type = 'out'), 0),
                   'list', coalesce(json_agg(json_build_object('type', m.type, 'amount', m.amount, 'reason', m.reason, 'who', w.name)
                              order by coalesce(m.device_time, m.created_at)) filter (where m.type <> 'drawer'), '[]'::json))
            from cash_movements m left join employees w on w.tenant_id = m.tenant_id and w.id = m.employee_id
           where m.tenant_id = dc.tenant_id and m.device_id = dc.device_id and m.deleted_at is null
             and coalesce(m.device_time, m.created_at) > coalesce(dc.from_time, '-infinity'::timestamptz)
             and coalesce(m.device_time, m.created_at) <= dc.closed_at) as cash
    from day_closes dc
    join stores s on s.tenant_id = dc.tenant_id and s.id = dc.store_id
    left join employees e on e.tenant_id = dc.tenant_id and e.id = dc.closed_by
    left join pos_devices d on d.tenant_id = dc.tenant_id and d.id = dc.device_id
   where dc.tenant_id = $1 and dc.deleted_at is null
     and (dc.closed_at at time zone s.timezone)::date between $2::date and $3::date
   order by dc.closed_at desc`;

export default async function DayCloseReport({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz);
    if (!ok) return { l, f, ok: false as const };
    return { l, f, ok: true as const, s, rows: (await c.query(SQL, [ctx.tenantId, f.from, f.to])).rows as Close[] };
  });
  const head = <PageHead title="Day closing" lede="The closing report of each day (the Z report): what was sold, how it was paid, and the cash put in and taken out. A day is closed on the till, under More." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const at = clock(d.l.tz);
  const detailed = d.s.dayCloseDetailed;
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/day-close" f={d.f} l={d.l} show={[]} />
      {d.rows.length === 0 && <Empty icon={CalendarCheck} title="No day was closed in these dates">Pick other dates. A day that is still open is under Sales summary.</Empty>}
      {d.rows.map((z) => {
        const t = z.totals;
        const total = Number(t.gross) - Number(t.refunded);
        return (
          <section key={z.id} className="card flush">
            <div className="card-head">
              <div>
                <h2>Closing no. {z.number} <span className="muted" style={{ fontWeight: 400 }}>· {z.till ?? "Till"}</span></h2>
                <p>{z.from_time ? at(z.from_time) : "From the first sale"} to {at(z.closed_at)}{z.closed_by ? ` · closed by ${z.closed_by}` : ""}</p>
              </div>
              <strong style={{ fontSize: 18 }}>{m(total)}</strong>
            </div>
            <div className="card-body">
              <div className="grid-3">
                <div>
                  <h3>Sales</h3>
                  <dl className="kv">
                    <dt>Receipts</dt><dd>{t.sales}</dd>
                    <dt>Sales</dt><dd>{m(t.gross)}</dd>
                    <dt>Refunds ({t.refunds})</dt><dd>-{m(t.refunded)}</dd>
                    <dt className="total">Total</dt><dd className="total">{m(total)}</dd>
                    <dt>Of which tax</dt><dd>{m(t.tax)}</dd>
                    <dt>Discounts given</dt><dd>{m(t.discounts)}</dd>
                  </dl>
                </div>
                <div>
                  <h3>By payment method</h3>
                  <dl className="kv">
                    {z.payments.map((p, i) => (<div key={i} style={{ display: "contents" }}><dt>{p.name ?? "Unknown"} ({p.n})</dt><dd>{m(p.amount)}</dd></div>))}
                    {z.payments.length === 0 && <dt className="muted">Nothing taken</dt>}
                  </dl>
                </div>
                <div>
                  <h3>Cash in and out</h3>
                  <dl className="kv">
                    <dt>Cash in</dt><dd>{m(z.cash.in)}</dd>
                    <dt>Cash out</dt><dd>-{m(z.cash.out)}</dd>
                    {z.cash.list.map((x, i) => (
                      <div key={i} style={{ display: "contents" }}>
                        <dt className="muted">{x.type === "in" ? "In" : "Out"}: {x.reason ?? "no reason"}{x.who ? ` (${x.who})` : ""}</dt>
                        <dd className="muted" style={{ fontWeight: 400 }}>{x.type === "out" ? "-" : ""}{m(x.amount)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
              {detailed && z.cats.length > 0 && (
                <table style={{ marginTop: 18, marginBottom: 0 }}>
                  <thead><tr><th>Category</th><th className="num">Quantity</th><th className="num">Sales before discounts</th></tr></thead>
                  <tbody>
                    {z.cats.map((c, i) => (
                      <tr key={i}><td>{c.name ?? <span className="muted">No category</span>}</td><td className="num">{fmtQty(Number(c.qty))}</td><td className="num strong">{m(c.amount)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      })}
      {!detailed && d.rows.length > 0 && <p className="muted">The breakdown by category is switched off under POS settings.</p>}
    </div>
  );
}
