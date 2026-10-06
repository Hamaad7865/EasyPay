import { UserRoundCheck } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money, withDefaults } from "@/lib/settings";
import { basics, RECEIPTS } from "@/lib/report";
import { Card, Empty, PageHead, type Search } from "../../ui";
import { Delta, Figure, SpanPicker, Standouts, pct, per, period, range, totals } from "../parts";

// How each member of staff sells, beside the restaurant as a whole. A sale is
// counted for whoever took the payment, as in the Sales summary; an order
// that was paid in parts is counted for whoever took the last one.

type Row = {
  name: string | null;
  net: number;
  accounts: number;
  loose: number;
  refunds: number;
  refunded: number;
  discounts: number;
  seated: number;
  covers: number;
  // seconds from the first send to the kitchen to the payment, over `turns` orders served at a table
  turn: number | null;
  turns: number;
};

export default async function StaffPerformance({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    // the time zone, the right to see reports and the settings, in one trip
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    const p = period(sp, b.tz);
    if (!b.ok) return { p, ok: false as const };
    return {
      p,
      ok: true as const,
      s: withDefaults(b.settings),
      all: await totals(c, ctx.tenantId, p.from, p.to),
      before: await totals(c, ctx.tenantId, p.prevFrom, p.prevTo),
      rows: (
        await c.query(
          `with r as (${RECEIPTS}),
           -- an order, with who took its last payment and when
           tk as (select distinct on (ticket_id) ticket_id, employee_id, covers, table_id, at as paid_at
                    from r where type = 'sale' and ticket_id is not null order by ticket_id, at desc),
           tt as (select tk.employee_id, extract(epoch from (tk.paid_at - s.sent))::float8 as secs
                    from tk cross join lateral (select min(tl.sent_to_kitchen_at) as sent from ticket_lines tl
                                                 where tl.tenant_id = $1 and tl.ticket_id = tk.ticket_id) s
                   -- tables only: a takeaway waits for its guest and a counter sale
                   -- is paid as it is sent, so neither says anything about service.
                   -- Both times are the till's own clock.
                   where tk.table_id is not null and s.sent is not null and tk.paid_at > s.sent),
           per as (select employee_id,
                          coalesce(sum(signed_total), 0)::float8 as net,
                          count(distinct ticket_id) filter (where type = 'sale')::int as accounts,
                          count(*) filter (where type = 'sale' and ticket_id is null)::int as loose,
                          count(*) filter (where type = 'refund')::int as refunds,
                          coalesce(sum(total) filter (where type = 'refund'), 0)::float8 as refunded,
                          coalesce(sum(sign * discount_total), 0)::float8 as discounts,
                          coalesce(sum(signed_total) filter (where covers > 0), 0)::float8 as seated
                     from r group by employee_id)
           select e.name, per.net, per.accounts, per.loose, per.refunds, per.refunded, per.discounts, per.seated,
                  coalesce((select sum(tk.covers) from tk where tk.employee_id is not distinct from per.employee_id), 0)::int as covers,
                  (select avg(tt.secs) from tt where tt.employee_id is not distinct from per.employee_id)::float8 as turn,
                  (select count(*) from tt where tt.employee_id is not distinct from per.employee_id)::int as turns
             from per left join employees e on e.tenant_id = $1 and e.id = per.employee_id
            order by per.net desc, e.name`,
          range(ctx.tenantId, p.from, p.to),
        )
      ).rows as Row[],
    };
  });

  const head = (
    <PageHead title="Staff performance" lede="What each member of staff sold, their average check and what they gave away, beside the restaurant as a whole." />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const { p, all, before } = d;
  const m = (v: number) => money(Math.round(v), d.s.decimals);
  const picker = <SpanPicker path="/backoffice/insights/staff" p={p} />;
  if (!d.rows.length) {
    return (
      <div>
        {head}
        {picker}
        <Empty icon={UserRoundCheck} title="No sales in these days">
          <p>Once the till has taken payments, each member of staff shows here.</p>
        </Empty>
      </div>
    );
  }

  const rows = d.rows.map((r) => {
    const orders = r.accounts + r.loose;
    return { ...r, name: r.name ?? "Not recorded", orders, check: per(r.net, orders), guest: per(r.seated, r.covers) };
  });
  const check = per(all.net, all.orders);
  const guest = per(all.seated, all.covers);
  const turns = rows.reduce((a, r) => a + r.turns, 0);
  const turn = per(rows.reduce((a, r) => a + (r.turn ?? 0) * r.turns, 0), turns);
  const mins = (secs: number) => `${Math.max(1, Math.round(secs / 60))} min`;
  const topNet = Math.max(...rows.map((r) => r.net), 1);
  const first = rows[0];
  // an average check over a handful of orders says little
  const steady = rows.filter((r) => r.orders >= 5);
  const bestCheck = steady.length > 1 ? steady.reduce((a, b) => (b.check > a.check ? b : a)) : null;
  const gave = rows.filter((r) => r.discounts > 0).sort((a, b) => b.discounts - a.discounts)[0];
  const refunds = rows.reduce((a, r) => a + r.refunds, 0);
  const refunded = rows.reduce((a, r) => a + r.refunded, 0);
  const mostRefunds = rows.filter((r) => r.refunds > 0).sort((a, b) => b.refunds - a.refunds)[0];

  return (
    <div>
      {head}
      {picker}
      <div className="stats">
        <Figure label="Net sales" value={m(all.net)} now={all.net} before={before.net} note={`on the ${p.days} days before`} none={`No sales in the ${p.days} days before`} />
        <Figure label="Average check" value={m(check)} now={check} before={per(before.net, before.orders)} note="per order, everyone" />
        <Figure label="Sales per guest" value={all.covers > 0 ? m(guest) : "No guests counted"} now={all.covers > 0 ? guest : undefined} before={per(before.seated, before.covers)} note={all.covers > 0 ? "on orders with a guest count" : undefined} />
        <Figure label="Send to payment" value={turns > 0 ? mins(turn) : "Nothing sent"} note={turns > 0 ? `on average, over ${turns} table ${turns === 1 ? "order" : "orders"}` : "no table order went to the kitchen"} />
      </div>

      <Standouts
        lines={[
          rows.length > 1 && all.net > 0 && (
            <>
              <b>{first.name}</b> took the most: {m(first.net)}, {pct(first.net / all.net)} of the sales.
            </>
          ),
          bestCheck && check > 0 && bestCheck.check > check && (
            <>
              <b>{bestCheck.name}</b> has the highest average check: {m(bestCheck.check)}, {pct(bestCheck.check / check - 1)} above the restaurant&apos;s {m(check)}.
            </>
          ),
          gave && (
            <>
              <b>{gave.name}</b> gave the most in discounts: {m(gave.discounts)}.
            </>
          ),
          refunds > 0 && (
            <>
              {refunds} {refunds === 1 ? "refund" : "refunds"} for {m(refunded)} in these days
              {mostRefunds && rows.length > 1 && (
                <>
                  {refunds === 1 ? ", taken by " : "; the most were taken by "}
                  <b>{mostRefunds.name}</b>
                </>
              )}
              .
            </>
          ),
        ]}
      />

      <Card title="By member of staff" lede="The chip beside a figure is how it stands against the restaurant's own" flush>
        <div className="table-scroll table-tight">
          <table>
            <thead>
              <tr>
                <th>Staff</th>
                <th className="num">Net sales</th>
                <th>Share of sales</th>
                <th className="num">Orders</th>
                <th className="num">Average check</th>
                <th className="num">Per guest</th>
                <th className="num">Discounts</th>
                <th className="num">Refunds</th>
                <th className="num">To payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="strong">{r.name}</td>
                  <td className="num">{m(r.net)}</td>
                  <td>
                    <span className="bar-with">
                      <span className="bar">
                        <i style={{ width: `${Math.max(0, (r.net / topNet) * 100)}%` }} />
                      </span>
                      {all.net > 0 ? pct(r.net / all.net) : "0%"}
                    </span>
                  </td>
                  <td className="num">{r.orders}</td>
                  <td className="num">
                    {m(r.check)}
                    <small className="cell-sub">{rows.length > 1 && r.orders > 0 ? <Delta now={r.check} before={check} /> : null}</small>
                  </td>
                  <td className="num">
                    {r.covers > 0 ? m(r.guest) : <span className="muted">None</span>}
                    <small className="cell-sub">
                      {r.covers > 0 ? (
                        <>
                          {r.covers} {r.covers === 1 ? "guest" : "guests"} {rows.length > 1 && <Delta now={r.guest} before={guest} />}
                        </>
                      ) : (
                        "no guests counted"
                      )}
                    </small>
                  </td>
                  <td className="num">{r.discounts > 0 ? m(r.discounts) : <span className="muted">None</span>}</td>
                  <td className="num">
                    {r.refunds > 0 ? m(r.refunded) : <span className="muted">None</span>}
                    {r.refunds > 0 && <small className="cell-sub">{r.refunds === 1 ? "1 refund" : `${r.refunds} refunds`}</small>}
                  </td>
                  <td className="num">
                    {r.turns > 0 && r.turn !== null ? mins(r.turn) : <span className="muted">None</span>}
                    {r.turns > 0 && <small className="cell-sub">{r.turns === 1 ? "1 order" : `${r.turns} orders`}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Restaurant</td>
                <td className="num">{m(all.net)}</td>
                <td />
                <td className="num">{all.orders}</td>
                <td className="num">{m(check)}</td>
                <td className="num">{all.covers > 0 ? m(guest) : ""}</td>
                <td className="num">{m(rows.reduce((a, r) => a + r.discounts, 0))}</td>
                <td className="num">{refunds > 0 ? m(refunded) : ""}</td>
                <td className="num">{turns > 0 ? mins(turn) : ""}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <p className="muted insight-foot">
        Send to payment is the time from a table order&apos;s first send to the kitchen until it is paid; takeaway, delivery and counter sales are left out of it. Guests are the covers entered on orders served at a table.
      </p>
    </div>
  );
}
