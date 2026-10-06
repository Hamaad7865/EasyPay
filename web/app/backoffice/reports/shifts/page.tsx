import { Timer } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { clock, filters, reportStart } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters } from "../parts";

type Shift = {
  id: string; opened_at: string; closed_at: string | null; opening_float: string; expected_cash: string | null; counted_cash: string | null;
  opened_by: string | null; closed_by: string | null; till: string | null;
  payments: { name: string | null; kind: string | null; amount: number; n: number }[];
  sales: { sales: number; refunds: number; gross: number; refunded: number; discounts: number };
  cash: { in: number; out: number; drawer: number; list: { type: string; amount: number; reason: string | null; at: string; who: string | null }[] };
  counts: { counted: number; expected: number; at: string; who: string | null }[];
};

// A sales period (a row of shifts) is one stretch of selling on a till: from the float it started with
// to the count at the end. Its window is what happened on that till between
// opening and closing.
const WINDOW = `r.tenant_id = sh.tenant_id and r.device_id = sh.device_id and r.deleted_at is null
  and coalesce(r.device_time, r.created_at) >= sh.opened_at and coalesce(r.device_time, r.created_at) <= coalesce(sh.closed_at, now())`;
const SQL = `
  select sh.id, sh.opened_at, sh.closed_at, sh.opening_float, sh.expected_cash, sh.counted_cash,
         o.name as opened_by, cl.name as closed_by, d.name as till,
         (select coalesce(json_agg(json_build_object('name', q.name, 'kind', q.kind, 'amount', q.amount, 'n', q.n) order by q.amount desc), '[]'::json)
            from (select pt.name, pt.kind, sum(case when r.type = 'refund' then -p.amount else p.amount end) as amount, count(*) as n
                    from receipts r join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                    left join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id
                   where ${WINDOW} group by pt.name, pt.kind) q) as payments,
         (select json_build_object('sales', count(*) filter (where r.type = 'sale'), 'refunds', count(*) filter (where r.type = 'refund'),
                   'gross', coalesce(sum(r.total) filter (where r.type = 'sale'), 0),
                   'refunded', coalesce(sum(r.total) filter (where r.type = 'refund'), 0),
                   'discounts', coalesce(sum(case when r.type = 'refund' then -r.discount_total else r.discount_total end), 0))
            from receipts r where ${WINDOW}) as sales,
         (select json_build_object('in', coalesce(sum(m.amount) filter (where m.type = 'in'), 0),
                   'out', coalesce(sum(m.amount) filter (where m.type = 'out'), 0),
                   'drawer', count(*) filter (where m.type = 'drawer'),
                   'list', coalesce(json_agg(json_build_object('type', m.type, 'amount', m.amount, 'reason', m.reason,
                              'at', coalesce(m.device_time, m.created_at), 'who', e.name)
                              order by coalesce(m.device_time, m.created_at)) filter (where m.type <> 'drawer'), '[]'::json))
            from cash_movements m left join employees e on e.tenant_id = m.tenant_id and e.id = m.employee_id
           where m.tenant_id = sh.tenant_id and m.device_id = sh.device_id and m.deleted_at is null
             and coalesce(m.device_time, m.created_at) >= sh.opened_at
             and coalesce(m.device_time, m.created_at) <= coalesce(sh.closed_at, now())) as cash,
         (select coalesce(json_agg(json_build_object('counted', dc.counted, 'expected', dc.expected,
                   'at', coalesce(dc.device_time, dc.created_at), 'who', e.name) order by coalesce(dc.device_time, dc.created_at)), '[]'::json)
            from drawer_counts dc left join employees e on e.tenant_id = dc.tenant_id and e.id = dc.employee_id
           where dc.tenant_id = sh.tenant_id and dc.shift_id = sh.id and dc.deleted_at is null) as counts
    from shifts sh
    join stores s on s.tenant_id = sh.tenant_id and s.id = sh.store_id
    left join employees o on o.tenant_id = sh.tenant_id and o.id = sh.opened_by
    left join employees cl on cl.tenant_id = sh.tenant_id and cl.id = sh.closed_by
    left join pos_devices d on d.tenant_id = sh.tenant_id and d.id = sh.device_id
   where sh.tenant_id = $1 and sh.deleted_at is null
     and (sh.opened_at at time zone s.timezone)::date between $2::date and $3::date
     and ($4::uuid is null or sh.opened_by = $4::uuid)
   order by sh.opened_at desc`;

export default async function ShiftReport({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz);
    if (!ok) return { l, f, ok: false as const };
    return {
      l, f, ok: true as const, s,
      shifts: (await c.query(SQL, [ctx.tenantId, f.from, f.to, f.employee])).rows as Shift[],
    };
  });
  const head = <PageHead title="Sales periods" lede="Each sales period on a till: the float it started with, what was taken, the cash put in and taken out, and how the drawer counted at the end." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const at = clock(d.l.tz);
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/shifts" f={d.f} l={d.l} show={["employee"]} />
      {d.shifts.length === 0 && <Empty icon={Timer} title="No sales period was opened in these days">Pick other dates.</Empty>}
      {d.shifts.map((sh) => {
        const cashTaken = sh.payments.filter((p) => p.kind === "cash").reduce((a, p) => a + Number(p.amount), 0);
        const expected = sh.closed_at && sh.expected_cash !== null ? Number(sh.expected_cash) : Number(sh.opening_float) + cashTaken + Number(sh.cash.in) - Number(sh.cash.out);
        const diff = sh.counted_cash === null ? null : Number(sh.counted_cash) - expected;
        return (
          <section key={sh.id} className="card flush">
            <div className="card-head">
              <div>
                <h2>{sh.opened_by ?? "Not recorded"} <span className="muted" style={{ fontWeight: 400 }}>· {sh.till ?? "Till"}</span></h2>
                <p>{at(sh.opened_at)} to {sh.closed_at ? at(sh.closed_at) : "now"}{sh.closed_by && sh.closed_by !== sh.opened_by ? ` · closed by ${sh.closed_by}` : ""}</p>
              </div>
              <span className="row-actions">
                {diff !== null && diff !== 0 && <span className={"badge " + (diff < 0 ? "red" : "amber")}>{diff < 0 ? "Short " : "Over "}{m(Math.abs(diff))}</span>}
                {diff === 0 && <span className="badge green">Drawer balanced</span>}
                <span className={"badge " + (sh.closed_at ? "" : "blue")}>{sh.closed_at ? "Closed" : "Open now"}</span>
              </span>
            </div>
            <div className="card-body">
              <div className="grid-3">
                <div>
                  <h3>Cash drawer</h3>
                  <dl className="kv">
                    <dt>Opening float</dt><dd>{m(sh.opening_float)}</dd>
                    <dt>Cash taken</dt><dd>{m(cashTaken)}</dd>
                    <dt>Cash in</dt><dd>{m(sh.cash.in)}</dd>
                    <dt>Cash out</dt><dd>-{m(sh.cash.out)}</dd>
                    <dt className="total">Expected in drawer</dt><dd className="total">{m(expected)}</dd>
                    <dt>Counted</dt><dd>{sh.counted_cash === null ? "Not counted yet" : m(sh.counted_cash)}</dd>
                    {diff !== null && (<><dt>Difference</dt><dd style={diff < 0 ? { color: "var(--red)" } : undefined}>{diff > 0 ? "+" : diff < 0 ? "-" : ""}{m(Math.abs(diff))}</dd></>)}
                  </dl>
                </div>
                <div>
                  <h3>Taken by payment method</h3>
                  <dl className="kv">
                    {sh.payments.map((p, i) => (<div key={i} style={{ display: "contents" }}><dt>{p.name ?? "Unknown"} ({p.n})</dt><dd>{m(p.amount)}</dd></div>))}
                    {sh.payments.length === 0 && <dt className="muted">Nothing taken</dt>}
                    <dt className="total">Total</dt><dd className="total">{m(sh.payments.reduce((a, p) => a + Number(p.amount), 0))}</dd>
                  </dl>
                </div>
                <div>
                  <h3>Sales</h3>
                  <dl className="kv">
                    <dt>Receipts</dt><dd>{sh.sales.sales}</dd>
                    <dt>Sales</dt><dd>{m(sh.sales.gross)}</dd>
                    <dt>Refunds ({sh.sales.refunds})</dt><dd>-{m(sh.sales.refunded)}</dd>
                    <dt>Discounts given</dt><dd>{m(sh.sales.discounts)}</dd>
                    <dt>Drawer opened without a sale</dt><dd>{sh.cash.drawer}</dd>
                  </dl>
                </div>
              </div>
              {sh.cash.list.length > 0 && (
                <table style={{ marginTop: 18, marginBottom: 0 }}>
                  <thead><tr><th>Cash movement</th><th>When</th><th>By</th><th>Reason</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {sh.cash.list.map((x, i) => (
                      <tr key={i}>
                        <td><span className={"badge " + (x.type === "in" ? "green" : "amber")}>{x.type === "in" ? "Cash in" : "Cash out"}</span></td>
                        <td>{at(x.at)}</td><td>{x.who ?? ""}</td><td>{x.reason ?? ""}</td>
                        <td className="num strong">{x.type === "out" ? "-" : ""}{m(x.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {sh.counts.length > 0 && (
                <table style={{ marginTop: 18, marginBottom: 0 }}>
                  <thead><tr><th>Drawer counted during the sales period</th><th>By</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th></tr></thead>
                  <tbody>
                    {sh.counts.map((x, i) => {
                      const off = Number(x.counted) - Number(x.expected);
                      return (
                        <tr key={i}>
                          <td>{at(x.at)}</td><td>{x.who ?? ""}</td>
                          <td className="num">{m(x.expected)}</td><td className="num strong">{m(x.counted)}</td>
                          <td className="num" style={off < 0 ? { color: "var(--red)" } : undefined}>{off > 0 ? "+" : off < 0 ? "-" : ""}{m(Math.abs(off))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
