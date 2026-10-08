import { CalendarCheck } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { clock, filters, fmtQty, reportStart } from "@/lib/report";
import { lineOffSql } from "@/lib/stock-reports";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters } from "../parts";

// A day on a till: opened by counting the cash in its drawer, closed by
// counting it again, which fixes the day's figures (the Z report). This page
// is every day of every till: the ones open now first, then the closed ones.
//
// In the tables a day is two rows written together when it is closed: a
// shift (the drawer, from its float to its count) and a day closing (the
// figures). They used to be closed apart, as a "sales period" and a "day":
// a closing from then can hold several drawers, and a drawer from then can
// have been counted with its day left open. Both still show here.

type Count = { counted: number; expected: number; at: string; who: string | null };
type Drawer = {
  opened_at: string; closed_at: string | null; opened_by: string | null; closed_by: string | null;
  float: string; expected: string | null; counted: string | null; counts: Count[];
};
type Close = {
  id: string; number: number; from_time: string | null; closed_at: string; closed_by: string | null; till: string | null;
  totals: { sales: number; refunds: number; gross: number; refunded: number; discounts: number; changed: number; tax: number };
  payments: { name: string | null; amount: number; n: number }[];
  cats: { name: string | null; qty: number; amount: number }[];
  cash: { in: number; out: number; list: { type: string; amount: number; reason: string | null; who: string | null }[] };
  drawers: Drawer[];
};
// a day not closed yet: open now, or (from before) counted and left open
type Open = {
  id: string; opened_at: string; closed_at: string | null; opening_float: string; expected_cash: string | null; counted_cash: string | null;
  opened_by: string | null; closed_by: string | null; till: string | null;
  payments: { name: string | null; kind: string | null; amount: number; n: number }[];
  sales: { sales: number; refunds: number; gross: number; refunded: number; discounts: number; changed: number };
  cash: { in: number; out: number; drawer: number; list: { type: string; amount: number; reason: string | null; at: string; who: string | null }[] };
  counts: Count[];
};

const COUNTS = (alias: string) => `
  (select coalesce(json_agg(json_build_object('counted', x.counted, 'expected', x.expected,
            'at', coalesce(x.device_time, x.created_at), 'who', w.name) order by coalesce(x.device_time, x.created_at)), '[]'::json)
     from drawer_counts x left join employees w on w.tenant_id = x.tenant_id and w.id = x.employee_id
    where x.tenant_id = ${alias}.tenant_id and x.shift_id = ${alias}.id and x.deleted_at is null)`;

// A day closing covers one till from the closing before it (or from its first
// sale) up to the moment it was closed. The figures are worked out from the
// receipts as they are now, so a sale that synced late is included.
const W = `r.tenant_id = dc.tenant_id and r.device_id = dc.device_id and r.deleted_at is null
  and coalesce(r.device_time, r.created_at) > coalesce(dc.from_time, '-infinity'::timestamptz)
  and coalesce(r.device_time, r.created_at) <= dc.closed_at`;
// the drawer(s) counted to close it: the shifts of that till that ended inside it
const INSIDE = `sh.tenant_id = dc.tenant_id and sh.device_id = dc.device_id and sh.deleted_at is null and sh.closed_at is not null
  and sh.closed_at > coalesce(dc.from_time, '-infinity'::timestamptz) and sh.closed_at <= dc.closed_at`;
// Discounts are the till's own figure: what was taken off whole sales, and (a
// shop) off single lines. What prices typed for one sale came to under the
// listed ones is said apart, as the till's report does.
const SIGN = `(case when r.type = 'refund' then -1 else 1 end)`;
const given = (shop: boolean) => `
                   'discounts', coalesce(sum(${SIGN} * (r.discount_total + ${lineOffSql(shop, "r", "discount", "r.tenant_id")})), 0),
                   'changed', coalesce(sum(${SIGN} * ${lineOffSql(shop, "r", "override", "r.tenant_id")}), 0)`;
const closedSql = (shop: boolean) => `
  select dc.id, dc.number, dc.from_time, dc.closed_at, e.name as closed_by, d.name as till,
         (select json_build_object('sales', count(*) filter (where r.type = 'sale'), 'refunds', count(*) filter (where r.type = 'refund'),
                   'gross', coalesce(sum(r.total) filter (where r.type = 'sale'), 0),
                   'refunded', coalesce(sum(r.total) filter (where r.type = 'refund'), 0),
${given(shop)},
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
             and coalesce(m.device_time, m.created_at) <= dc.closed_at) as cash,
         (select coalesce(json_agg(json_build_object('opened_at', sh.opened_at, 'closed_at', sh.closed_at, 'opened_by', o.name, 'closed_by', cl.name,
                   'float', sh.opening_float, 'expected', sh.expected_cash, 'counted', sh.counted_cash, 'counts', ${COUNTS("sh")})
                   order by sh.opened_at), '[]'::json)
            from shifts sh
            left join employees o on o.tenant_id = sh.tenant_id and o.id = sh.opened_by
            left join employees cl on cl.tenant_id = sh.tenant_id and cl.id = sh.closed_by
           where ${INSIDE}) as drawers
    from day_closes dc
    join stores s on s.tenant_id = dc.tenant_id and s.id = dc.store_id
    left join employees e on e.tenant_id = dc.tenant_id and e.id = dc.closed_by
    left join pos_devices d on d.tenant_id = dc.tenant_id and d.id = dc.device_id
   where dc.tenant_id = $1 and dc.deleted_at is null
     and (dc.closed_at at time zone s.timezone)::date between $2::date and $3::date
   order by dc.closed_at desc`;

// The days no closing covers: open now (shown whenever the dates reach
// today), or counted and left open, from before closing was one step.
const WINDOW = `r.tenant_id = sh.tenant_id and r.device_id = sh.device_id and r.deleted_at is null
  and coalesce(r.device_time, r.created_at) >= sh.opened_at and coalesce(r.device_time, r.created_at) <= coalesce(sh.closed_at, now())`;
const openSql = (shop: boolean) => `
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
${given(shop)})
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
         ${COUNTS("sh")} as counts
    from shifts sh
    join stores s on s.tenant_id = sh.tenant_id and s.id = sh.store_id
    left join employees o on o.tenant_id = sh.tenant_id and o.id = sh.opened_by
    left join employees cl on cl.tenant_id = sh.tenant_id and cl.id = sh.closed_by
    left join pos_devices d on d.tenant_id = sh.tenant_id and d.id = sh.device_id
   where sh.tenant_id = $1 and sh.deleted_at is null
     and not exists (select 1 from day_closes dc where ${INSIDE})
     and case when sh.closed_at is null then $3::date >= (now() at time zone s.timezone)::date
              else (sh.opened_at at time zone s.timezone)::date between $2::date and $3::date end
   order by sh.closed_at is not null, sh.opened_at desc`;

export default async function DayCloseReport({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz);
    if (!ok) return { l, f, ok: false as const };
    // the two lists are asked for together: one trip
    const [closed, open] = await Promise.all([c.query(closedSql(ctx.mode === "retail"), [ctx.tenantId, f.from, f.to]), c.query(openSql(ctx.mode === "retail"), [ctx.tenantId, f.from, f.to])]);
    return { l, f, ok: true as const, s, rows: closed.rows as Close[], open: open.rows as Open[] };
  });
  const head = (
    <PageHead
      title="Day closing"
      lede="Each day on each till: opened by counting the cash in the drawer, closed by counting it again, which fixes the day's figures (the Z report). What was sold, how it was paid, the cash put in and taken out, and how the drawer counted. A day is opened and closed on the till."
    />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const at = clock(d.l.tz);
  const detailed = d.s.dayCloseDetailed;
  const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "") + m(Math.abs(n));
  const balance = (diff: number | null) =>
    diff === null ? null : diff === 0 ? <span className="badge green">Drawer balanced</span> : <span className={"badge " + (diff < 0 ? "red" : "amber")}>{diff < 0 ? "Short " : "Over "}{m(Math.abs(diff))}</span>;
  const counts = (list: Count[]) =>
    list.length > 0 && (
      <table style={{ marginTop: 18, marginBottom: 0 }}>
        <thead><tr><th>Drawer counted during the day</th><th>By</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th></tr></thead>
        <tbody>
          {list.map((x, i) => {
            const off = Number(x.counted) - Number(x.expected);
            return (
              <tr key={i}>
                <td>{at(x.at)}</td><td>{x.who ?? ""}</td>
                <td className="num">{m(x.expected)}</td><td className="num strong">{m(x.counted)}</td>
                <td className="num" style={off < 0 ? { color: "var(--red)" } : undefined}>{signed(off)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/day-close" f={d.f} l={d.l} show={[]} />
      {d.rows.length === 0 && d.open.length === 0 && <Empty icon={CalendarCheck} title="No day was opened or closed in these dates">Pick other dates.</Empty>}

      {d.open.map((sh) => {
        const cashTaken = sh.payments.filter((p) => p.kind === "cash").reduce((a, p) => a + Number(p.amount), 0);
        const expected = sh.closed_at && sh.expected_cash !== null ? Number(sh.expected_cash) : Number(sh.opening_float) + cashTaken + Number(sh.cash.in) - Number(sh.cash.out);
        const diff = sh.counted_cash === null ? null : Number(sh.counted_cash) - expected;
        return (
          <section key={sh.id} className="card flush">
            <div className="card-head">
              <div>
                <h2>{sh.closed_at ? "Day not closed" : "Day open now"} <span className="muted" style={{ fontWeight: 400 }}>· {sh.till ?? "Till"}</span></h2>
                <p>
                  Opened {at(sh.opened_at)}{sh.opened_by ? ` by ${sh.opened_by}` : ""}
                  {sh.closed_at ? `. Its drawer was counted ${at(sh.closed_at)}${sh.closed_by ? ` by ${sh.closed_by}` : ""}, and the day itself was left open: its sales go into the next closing on that till.` : ""}
                </p>
              </div>
              <span className="row-actions">
                {balance(diff)}
                <span className={"badge " + (sh.closed_at ? "amber" : "blue")}>{sh.closed_at ? "Not closed" : "Open now"}</span>
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
                    <dt>Counted</dt><dd>{sh.counted_cash === null ? "At closing" : m(sh.counted_cash)}</dd>
                    {diff !== null && (<><dt>Difference</dt><dd style={diff < 0 ? { color: "var(--red)" } : undefined}>{signed(diff)}</dd></>)}
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
                  <h3>{sh.closed_at ? "Sales" : "Sales so far"}</h3>
                  <dl className="kv">
                    <dt>Receipts</dt><dd>{sh.sales.sales}</dd>
                    <dt>Sales</dt><dd>{m(sh.sales.gross)}</dd>
                    <dt>Refunds ({sh.sales.refunds})</dt><dd>-{m(sh.sales.refunded)}</dd>
                    <dt>Discounts given</dt><dd>{m(sh.sales.discounts)}</dd>
                    {Number(sh.sales.changed) !== 0 && (<><dt>Prices typed, {Number(sh.sales.changed) > 0 ? "under" : "over"} the listed prices</dt><dd>{m(Math.abs(Number(sh.sales.changed)))}</dd></>)}
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
              {counts(sh.counts)}
            </div>
          </section>
        );
      })}

      {d.rows.map((z) => {
        const t = z.totals;
        const total = Number(t.gross) - Number(t.refunded);
        // one drawer for a day closed in one step; several for a day from before, closed after more than one count
        const last = z.drawers[z.drawers.length - 1];
        const diff = z.drawers.length === 1 && last.counted !== null && last.expected !== null ? Number(last.counted) - Number(last.expected) : null;
        return (
          <section key={z.id} className="card flush">
            <div className="card-head">
              <div>
                <h2>Closing no. {z.number} <span className="muted" style={{ fontWeight: 400 }}>· {z.till ?? "Till"}</span></h2>
                <p>
                  {z.drawers.length === 1 ? `Opened ${at(last.opened_at)}${last.opened_by ? ` by ${last.opened_by}` : ""}` : z.from_time ? `From ${at(z.from_time)}` : "From the first sale"}
                  {`, closed ${at(z.closed_at)}`}{z.closed_by ? ` by ${z.closed_by}` : ""}
                </p>
              </div>
              <span className="row-actions">
                {balance(diff)}
                <strong style={{ fontSize: 18 }}>{m(total)}</strong>
              </span>
            </div>
            <div className="card-body">
              <div className="grid-2">
                <div>
                  <h3>Sales</h3>
                  <dl className="kv">
                    <dt>Receipts</dt><dd>{t.sales}</dd>
                    <dt>Sales</dt><dd>{m(t.gross)}</dd>
                    <dt>Refunds ({t.refunds})</dt><dd>-{m(t.refunded)}</dd>
                    <dt className="total">Total</dt><dd className="total">{m(total)}</dd>
                    <dt>Of which tax</dt><dd>{m(t.tax)}</dd>
                    <dt>Discounts given</dt><dd>{m(t.discounts)}</dd>
                    {Number(t.changed) !== 0 && (<><dt>Prices typed, {Number(t.changed) > 0 ? "under" : "over"} the listed prices</dt><dd>{m(Math.abs(Number(t.changed)))}</dd></>)}
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
                  <h3>Cash drawer</h3>
                  {z.drawers.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>Closed with no day open on the till, so no drawer was counted.</p>
                  ) : (
                    z.drawers.map((w, i) => {
                      const off = w.counted !== null && w.expected !== null ? Number(w.counted) - Number(w.expected) : null;
                      return (
                        <dl key={i} className="kv" style={i > 0 ? { marginTop: 12 } : undefined}>
                          {z.drawers.length > 1 && (<><dt className="muted">{at(w.opened_at)} to {w.closed_at ? at(w.closed_at) : ""}</dt><dd className="muted" style={{ fontWeight: 400 }}>{w.opened_by ?? ""}</dd></>)}
                          <dt>Opening float</dt><dd>{m(w.float)}</dd>
                          <dt className="total">Expected in drawer</dt><dd className="total">{w.expected === null ? "" : m(w.expected)}</dd>
                          <dt>Counted</dt><dd>{w.counted === null ? "" : m(w.counted)}</dd>
                          {off !== null && (<><dt>Difference</dt><dd style={off < 0 ? { color: "var(--red)" } : undefined}>{signed(off)}</dd></>)}
                        </dl>
                      );
                    })
                  )}
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
              {counts(z.drawers.flatMap((w) => w.counts))}
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
