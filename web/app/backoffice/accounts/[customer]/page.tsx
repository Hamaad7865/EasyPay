import Link from "next/link";
import { notFound } from "next/navigation";
import { BookUser } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { canView, clock, fmtDay, lists } from "@/lib/report";
import { aged, ageSql, BUCKETS, type Bill, FLAG, ledger } from "@/lib/accounts";
import { Card, Empty, PageHead, type Search } from "../../ui";
import { Stat } from "../../reports/parts";

// One customer's account (migration 0114), as Carfectionist's: what they
// owe, aged; each bill that still owes with what was paid on it and taken off
// it; then every line of the account with a running balance. Paying happens
// at a till.

const LEDGER_LIMIT = 200;

type Move = { bill_id: string; kind: "payment" | "return"; number: string; at: string; method: string | null; amount: string; who: string | null };

export default async function AccountPage({ params, searchParams }: { params: Promise<{ customer: string }>; searchParams: Search }) {
  const { customer } = await params;
  await searchParams;
  const ctx = await tenantContext();
  if (ctx.mode !== "retail" || !UUID.test(customer)) notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const may = await canView(c, ctx.employeeId);
    const who = (
      await c.query(`select name, phone, email, deleted_at is not null as removed from customers where tenant_id = $1 and id = $2`, [ctx.tenantId, customer])
    ).rows[0] as { name: string; phone: string | null; email: string | null; removed: boolean } | undefined;
    const s = await loadSettings(c, ctx.tenantId);
    const tz = (await lists(c, ctx.tenantId)).tz;
    if (!who || !may) return { may, who, s, tz, bills: [] as Bill[], moves: [] as Move[], lines: [] as Awaited<ReturnType<typeof ledger>> };
    // the bills that still owe, and those paid over; oldest first
    const bills = (
      await c.query(
        `select b.id, b.number, b.day::text as day, b.amount, b.paid, b.returned, account_owed(b) as owed, ${ageSql("b")} as age, b.customer_id, b.flags
           from account_bills b
          where b.tenant_id = $1 and b.customer_id = $2 and b.deleted_at is null and account_owed(b) <> 0
          order by b.day, b.number`,
        [ctx.tenantId, customer],
      )
    ).rows as Bill[];
    const ids = bills.map((b) => b.id);
    const moves = ids.length
      ? ((
          await c.query(
            `select l.bill_id, 'payment' as kind, q.number, q.device_time as at, pt.name as method, l.amount, e.name as who
               from account_payment_lines l
               join account_payments q on q.tenant_id = l.tenant_id and q.id = l.account_payment_id
               left join payment_types pt on pt.tenant_id = q.tenant_id and pt.id = q.payment_type_id
               left join employees e on e.tenant_id = q.tenant_id and e.id = q.employee_id
              where l.tenant_id = $1 and l.bill_id = any($2::uuid[])
             union all
             select r.refund_of, 'return', r.number, coalesce(r.device_time, r.created_at), null, sum(p.amount), e.name
               from receipts r
               join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
               join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id and pt.kind = 'account'
               left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
              where r.tenant_id = $1 and r.type = 'refund' and r.refund_of = any($2::uuid[]) and r.deleted_at is null
              group by r.refund_of, r.number, r.device_time, r.created_at, e.name
              order by 4`,
            [ctx.tenantId, ids],
          )
        ).rows as Move[])
      : [];
    return { may, who, s, tz, bills, moves, lines: await ledger(c, ctx.tenantId, customer) };
  });
  if (!d.who) notFound();
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const at = clock(d.tz);
  const days = d.s.accountDays;
  const head = (
    <PageHead title={d.who.name} lede={[d.who.phone, d.who.email, d.who.removed ? "removed from Customers; their account stays" : null].filter(Boolean).join(" · ") || undefined}>
      <Link href="/backoffice/accounts" className="btn-quiet">All accounts</Link>
      <Link href={`/backoffice/customers/${customer}`} className="btn-quiet">History</Link>
      <Link href={`/backoffice/accounts/${customer}/statement`} className="btn">Statement</Link>
    </PageHead>
  );
  if (!d.may) return <div>{head}<Empty icon={BookUser} title="Not for this login">Accounts are shown to those allowed to see reports.</Empty></div>;
  const balance = d.bills.reduce((a, b) => a + Number(b.owed), 0);
  const open = d.bills.filter((b) => Number(b.owed) > 0);
  const oldest = open[0] ?? null;
  const buckets = aged(d.bills);
  const tail = d.lines.slice(-LEDGER_LIMIT);
  const last = d.lines.length ? d.lines[d.lines.length - 1].balance : 0;
  return (
    <div>
      {head}
      <div className="stats three">
        <Stat label="Balance owed" value={m(balance)} note={balance < 0 ? "The shop owes the customer" : undefined} />
        <Stat label="Open bills" value={String(open.length)} />
        <Stat label="Oldest unpaid" value={oldest ? `${oldest.age} ${oldest.age === 1 ? "day" : "days"}` : "None"} note={oldest ? `since ${fmtDay(oldest.day)}${oldest.age > days ? ", overdue" : ""}` : undefined} />
      </div>
      {last !== balance && (
        <div className="note warn">
          <strong>The account's lines come to {m(last)}, the bills to {m(balance)}.</strong>A bill or a payment is flagged below: check it on Accounts, Exceptions.
        </div>
      )}
      {buckets.some((v) => v !== 0) && (
        <Card title="Balance, aged" flush>
          <table>
            <thead>
              <tr>
                <th className="num">Owed</th>
                {BUCKETS.map((b) => <th key={b.key} className="num">{b.label}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num strong">{m(buckets.reduce((a, v) => a + v, 0))}</td>
                {buckets.map((v, i) => <td key={i} className={i > 0 && v > 0 ? "num neg" : "num"}>{v ? m(v) : ""}</td>)}
              </tr>
            </tbody>
          </table>
        </Card>
      )}
      <Card title="Bills and what was paid on them" flush>
        {d.bills.length === 0 ? (
          <p className="muted" style={{ padding: "16px 20px", margin: 0 }}>Nothing is owed. Every bill is paid; the account's lines are below.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Bill</th><th>Day</th><th className="num">On account</th><th className="num">Paid</th><th className="num">Returned</th><th className="num">Still owed</th></tr>
            </thead>
            <tbody>
              {d.bills.map((b) => {
                const mv = d.moves.filter((x) => x.bill_id === b.id);
                return [
                  <tr key={b.id}>
                    <td className="strong">
                      <Link href={`/backoffice/receipts?q=${encodeURIComponent(b.number)}`}>{b.number}</Link>
                      {b.flags.length > 0 && <span className="sub">Check: {[...new Set(b.flags.map((f) => FLAG[f.why] ?? f.why))].join("; ")}</span>}
                    </td>
                    <td className={b.age > days && Number(b.owed) > 0 ? "neg" : undefined}>{fmtDay(b.day)} · {b.age} {b.age === 1 ? "day" : "days"}</td>
                    <td className="num">{m(b.amount)}</td>
                    <td className="num">{Number(b.paid) ? m(b.paid) : ""}</td>
                    <td className="num">{Number(b.returned) ? m(b.returned) : ""}</td>
                    <td className={Number(b.owed) < 0 ? "num strong neg" : "num strong"}>{Number(b.owed) < 0 ? `${m(-Number(b.owed))} paid over` : m(b.owed)}</td>
                  </tr>,
                  ...mv.map((x, i) => (
                    <tr key={b.id + "-" + i}>
                      <td colSpan={2} style={{ paddingLeft: 32 }}>
                        <span className="muted">{x.kind === "payment" ? `Paid, ${x.method ?? "Unknown"} · ${x.number}` : `Returned goods · ${x.number}`}</span>
                        <span className="sub">{[at(x.at), x.who].filter(Boolean).join(" · ")}</span>
                      </td>
                      <td />
                      <td className="num muted">{x.kind === "payment" ? m(x.amount) : ""}</td>
                      <td className="num muted">{x.kind === "return" ? m(x.amount) : ""}</td>
                      <td />
                    </tr>
                  )),
                ];
              })}
            </tbody>
            <tfoot>
              <tr><td colSpan={5}>Balance owed</td><td className="num">{m(balance)}</td></tr>
            </tfoot>
          </table>
        )}
      </Card>
      <Card title="The account" lede={d.lines.length > tail.length ? `The latest ${tail.length} of ${d.lines.length} lines` : "Every sale on account, payment and return, with the balance after each"} flush>
        {tail.length === 0 ? (
          <p className="muted" style={{ padding: "16px 20px", margin: 0 }}>Nothing was ever sold on account to this customer.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Day</th><th>What</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr>
            </thead>
            <tbody>
              {tail.map((l, i) => (
                <tr key={i}>
                  <td>{fmtDay(l.day)}</td>
                  <td>
                    {l.kind === "payment" ? l.ref : <Link href={`/backoffice/receipts?q=${encodeURIComponent(l.ref)}`}>{l.ref}</Link>}
                    <span className="sub">{l.detail}</span>
                  </td>
                  <td className="num">{l.debit ? m(l.debit) : ""}</td>
                  <td className="num">{l.credit ? m(l.credit) : ""}</td>
                  <td className="num strong">{m(l.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
