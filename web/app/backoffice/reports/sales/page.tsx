import { BarChart3 } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { args, filters, fmtDay, RECEIPTS, reportStart } from "@/lib/report";
import { linePricesSql } from "@/lib/stock-reports";
import { pickedOf } from "@/lib/branch";
import { Card, Empty, PageHead, type Search } from "../../ui";
import { BranchPicker } from "../../branch-picker";
import { ReportFilters, Stat } from "../parts";

type Totals = { sales: number; refunds: number; orders: number; gross: string; refunded: string; discounts: string; tax: string; total: string };
// what a shop's till took off single lines, and what prices typed for one sale came to, on the sales alone
type LinePrices = { sold_off: string; sold_changed: string };
type Split = { name: string | null; n: number; amount: string };

export default async function SalesSummary({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz, (await pickedOf(l.stores))?.id ?? null);
    if (!ok) return { l, f, ok: false as const };
    const a = args(ctx.tenantId, f);
    const q = async <T,>(sql: string) => (await c.query(`with r as (${RECEIPTS}) ${sql}`, a)).rows as T[];
    return {
      l,
      f,
      ok: true as const,
      s,
      // All branches, of an account that has several: each branch's part (the spec's section 4)
      branches:
        f.store === null && l.stores.length > 1
          ? await q<Split & { refunds: string }>(
              `select r.store_name as name, count(*) filter (where r.type = 'sale')::int as n,
                      coalesce(sum(r.total) filter (where r.type = 'refund'), 0) as refunds, sum(r.signed_total) as amount
                 from r group by r.store_id, r.store_name order by sum(r.signed_total) desc, r.store_name`,
            )
          : [],
      totals: (
        await q<Totals>(
          `select count(*) filter (where type = 'sale')::int as sales, count(*) filter (where type = 'refund')::int as refunds,
                  count(distinct ticket_id) filter (where type = 'sale')::int as orders,
                  coalesce(sum(total) filter (where type = 'sale'), 0) as gross,
                  coalesce(sum(total) filter (where type = 'refund'), 0) as refunded,
                  -- on the sales alone: it is said under "Sales before refunds"
                  coalesce(sum(discount_total) filter (where type = 'sale'), 0) as discounts,
                  coalesce(sum(sign * tax_total), 0) as tax, coalesce(sum(signed_total), 0) as total from r`,
        )
      )[0],
      days: await q<{ day: string; n: number; refunds: string; total: string }>(
        `select day::text, count(*) filter (where type = 'sale')::int as n,
                coalesce(sum(total) filter (where type = 'refund'), 0) as refunds, sum(signed_total) as total
           from r group by day order by day`,
      ),
      // a shop's two built-in kinds hold no money: what an exchange settled with
      // returned goods (0079) and what a credit note covered (0109) are not tenders
      payments: await q<Split>(
        `select pt.name, count(*)::int as n, sum(r.sign * p.amount) as amount
           from r join receipt_payments_effective p on p.tenant_id = $1 and p.receipt_id = r.id
           left join payment_types pt on pt.tenant_id = $1 and pt.id = p.payment_type_id
          where coalesce(pt.kind, '') not in ('exchange', 'credit_note', 'deposit', 'account')
          group by pt.name order by sum(r.sign * p.amount) desc`,
      ),
      // credit notes: what refunds put on them and what sales took off them, in these days
      notes: (
        await q<{ issued: string; redeemed: string }>(
          `select coalesce(sum(p.amount) filter (where r.type = 'refund'), 0) as issued, coalesce(sum(p.amount) filter (where r.type = 'sale'), 0) as redeemed
             from r join receipt_payments_effective p on p.tenant_id = $1 and p.receipt_id = r.id
             join payment_types pt on pt.tenant_id = $1 and pt.id = p.payment_type_id and pt.kind = 'credit_note'`,
        )
      )[0],
      // a shop's deposits (0113): money taken on them in these days, and where deposit money went. None of it is a sale.
      deposits:
        ctx.mode === "retail"
          ? ((
              await c.query(
                `with r as (${RECEIPTS})
                 select coalesce((select sum(q.amount) from deposit_payments q join deposits d on d.tenant_id = q.tenant_id and d.id = q.deposit_id
                                    join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
                                   where q.tenant_id = $1 and q.kind = 'in' and (q.device_time at time zone s.timezone)::date between $2::date and $3::date
                                     and ($7::uuid is null or d.store_id = $7::uuid)), 0) as taken,
                        coalesce((select -sum(q.amount) from deposit_payments q join deposits d on d.tenant_id = q.tenant_id and d.id = q.deposit_id
                                    join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
                                   where q.tenant_id = $1 and q.kind = 'back' and (q.device_time at time zone s.timezone)::date between $2::date and $3::date
                                     and ($7::uuid is null or d.store_id = $7::uuid)), 0) as back,
                        coalesce((select sum(r.sign * p.amount) from r join receipt_payments_effective p on p.tenant_id = $1 and p.receipt_id = r.id
                                    join payment_types pt on pt.tenant_id = $1 and pt.id = p.payment_type_id and pt.kind = 'deposit'), 0) as used,
                        coalesce((select sum(d.noted) from deposits d join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
                                   where d.tenant_id = $1 and (d.cancelled_at at time zone s.timezone)::date between $2::date and $3::date
                                     and ($7::uuid is null or d.store_id = $7::uuid)), 0) as noted,
                        coalesce((select sum(d.kept) from deposits d join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
                                   where d.tenant_id = $1 and (d.cancelled_at at time zone s.timezone)::date between $2::date and $3::date
                                     and ($7::uuid is null or d.store_id = $7::uuid)), 0) as kept`,
                a,
              )
            ).rows[0] as { taken: string; back: string; used: string; noted: string; kept: string })
          : null,
      // a shop's customer accounts (0114): what of these sales went on accounts and
      // what returns took off them (no money moved), and money paid on accounts in
      // these days (money in, never a sale)
      accounts:
        ctx.mode === "retail"
          ? ((
              await c.query(
                `with r as (${RECEIPTS})
                 select coalesce((select sum(r.sign * p.amount) from r join receipt_payments_effective p on p.tenant_id = $1 and p.receipt_id = r.id
                                    join payment_types pt on pt.tenant_id = $1 and pt.id = p.payment_type_id and pt.kind = 'account'), 0) as on_account,
                        coalesce((select sum(q.amount) from account_payments q join stores s on s.tenant_id = q.tenant_id and s.id = q.store_id
                                   where q.tenant_id = $1 and (q.device_time at time zone s.timezone)::date between $2::date and $3::date
                                     and ($4::uuid is null or q.employee_id = $4::uuid)
                                     and ($7::uuid is null or q.store_id = $7::uuid)), 0) as paid_in`,
                a,
              )
            ).rows[0] as { on_account: string; paid_in: string })
          : null,
      dining: await q<Split>(
        `select o.name, count(*)::int as n, sum(r.signed_total) as amount from r
           left join dining_options o on o.tenant_id = $1 and o.id = r.dining_option_id group by o.name order by sum(r.signed_total) desc`,
      ),
      staff: await q<Split>(
        `select e.name, count(*)::int as n, sum(r.signed_total) as amount from r
           left join employees e on e.tenant_id = $1 and e.id = r.employee_id group by e.name order by sum(r.signed_total) desc`,
      ),
      // what a shop's till took off single lines, or charged at another price:
      // a receipt's own discount holds neither. A restaurant's till has neither, and is not asked.
      lines: ctx.mode === "retail" ? ((await c.query(linePricesSql(RECEIPTS), a)).rows[0] as LinePrices) : ({ sold_off: "0", sold_changed: "0" } satisfies LinePrices),
    };
  });
  // a shop's sales are all rung up at the counter: it has no order types to split by, or to pick
  const shop = ctx.mode === "retail";
  const head = (
    <PageHead title="Sales summary" lede={`What was sold, refunded and collected over the days you pick, and how it splits by payment method${shop ? "" : ", order type"} and member of staff.`}>
      <BranchPicker all={d.l.stores} picked={d.f.store} />
    </PageHead>
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const t = d.totals;
  const net = Number(t.total) - Number(t.tax);
  // everything taken off the sales: on the bill, and on single lines
  const lineOff = Number(d.lines.sold_off);
  const discounts = Number(t.discounts) + lineOff;
  const changed = Number(d.lines.sold_changed);
  const split = (title: string, rows: Split[], none: string) => (
    <Card title={title} flush>
      <table>
        <thead><tr><th>{title.replace("By ", "")}</th><th className="num">Receipts</th><th className="num">Amount</th><th>Share</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name ?? <span className="muted">{none}</span>}</td>
              <td className="num">{r.n}</td>
              <td className="num strong">{m(r.amount)}</td>
              <td><span className="bar"><i style={{ width: `${Number(t.total) > 0 ? Math.max(0, Math.min(100, (Number(r.amount) / Number(t.total)) * 100)) : 0}%` }} /></span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/sales" f={d.f} l={d.l} show={shop ? ["employee", "kind"] : ["employee", "dining", "kind"]} />
      {t.sales + t.refunds === 0 ? (
        <Empty icon={BarChart3} title="No sales in these days">Pick other dates, or clear the filters.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat
              label="Total collected"
              value={m(t.total)}
              note={`${t.sales} receipts on ${t.orders} orders` + (d.accounts && Number(d.accounts.on_account) !== 0 ? `; ${m(d.accounts.on_account)} of it on account, not yet paid` : "")}
            />
            <Stat label="Sales before refunds" value={m(t.gross)} note={discounts !== 0 ? `after ${m(discounts)} of discounts` : undefined} />
            <Stat label="Refunds" value={m(t.refunded)} note={`${t.refunds} ${t.refunds === 1 ? "refund" : "refunds"}`} />
            <Stat label="Net of tax" value={m(net)} note={`tax ${m(t.tax)}`} />
          </div>
          {(lineOff !== 0 || changed !== 0) && (
            <p className="muted">
              {lineOff !== 0 && `${m(lineOff)} of the discounts were given on single lines, ${m(t.discounts)} on whole sales. `}
              {changed !== 0 && `Prices typed for one sale came to ${m(Math.abs(changed))} ${changed > 0 ? "below" : "above"} the listed prices: that is not counted as a discount.`}
            </p>
          )}
          <Card title="By day" flush>
            <table>
              <thead><tr><th>Day</th><th className="num">Receipts</th><th className="num">Refunds</th><th className="num">Total</th></tr></thead>
              <tbody>
                {d.days.map((r) => (
                  <tr key={r.day}><td>{fmtDay(r.day)}</td><td className="num">{r.n}</td><td className="num">{Number(r.refunds) ? m(r.refunds) : ""}</td><td className="num strong">{m(r.total)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td className="num">{t.sales}</td><td className="num">{Number(t.refunded) ? m(t.refunded) : ""}</td><td className="num">{m(t.total)}</td></tr></tfoot>
            </table>
          </Card>
          {d.branches.length > 0 && (
            <Card title="By branch" flush>
              <table>
                <thead><tr><th>Branch</th><th className="num">Receipts</th><th className="num">Refunds</th><th className="num">Total</th><th>Share</th></tr></thead>
                <tbody>
                  {d.branches.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td className="num">{r.n}</td>
                      <td className="num">{Number(r.refunds) ? m(r.refunds) : ""}</td>
                      <td className="num strong">{m(r.amount)}</td>
                      <td><span className="bar"><i style={{ width: `${Number(t.total) > 0 ? Math.max(0, Math.min(100, (Number(r.amount) / Number(t.total)) * 100)) : 0}%` }} /></span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {shop ? (
            <>
              <div className="grid-2">
                {split("By payment method", d.payments, "Unknown")}
                {split("By employee", d.staff, "Not recorded")}
              </div>
              {(Number(d.notes.issued) !== 0 || Number(d.notes.redeemed) !== 0) && (
                <p className="muted">Credit notes: {m(d.notes.issued)} issued on exchanges, {m(d.notes.redeemed)} redeemed on sales. Neither is money taken, so neither is among the payment methods.</p>
              )}
              {d.deposits && [d.deposits.taken, d.deposits.back, d.deposits.used, d.deposits.noted, d.deposits.kept].some((v) => Number(v) !== 0) && (
                <p className="muted">
                  Deposits: {m(d.deposits.taken)} taken, {m(d.deposits.used)} used on collected goods, {m(d.deposits.back)} given back, {m(d.deposits.noted)} put on credit notes,{" "}
                  {m(d.deposits.kept)} kept by the shop. A deposit is not a sale: the sale is written when the goods are collected.
                </p>
              )}
              {d.accounts && (Number(d.accounts.on_account) !== 0 || Number(d.accounts.paid_in) !== 0) && (
                <p className="muted">
                  Customer accounts: {m(d.accounts.on_account)} of these sales went on customers' accounts, less what returns took off them; it is in the
                  total and in no payment method, since no money came in. {m(d.accounts.paid_in)} was paid on accounts in these days: money taken, not a
                  sale, so it is in neither the total nor the methods above. See Accounts.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="grid-2">
                {split("By payment method", d.payments, "Unknown")}
                {split("By order type", d.dining, "Not set")}
              </div>
              {split("By employee", d.staff, "Not recorded")}
            </>
          )}
        </>
      )}
    </div>
  );
}
