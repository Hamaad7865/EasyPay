import Link from "next/link";
import { notFound } from "next/navigation";
import { BookUser } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { canView, clock, fmtDay, lists } from "@/lib/report";
import { ageSql, FLAG } from "@/lib/accounts";
import { Empty, Flash, one, PageHead, type Search } from "../ui";
import { Stat } from "../reports/parts";
import { Submit } from "../busy";

// A shop's customer accounts (migration 0114), as Carfectionist's
// Reconciliation: who owes the shop, how old each debt is, and what looks
// wrong. Sold on account, paid off and returned at a till, where the money
// is; this page only shows. A customer opens to their account and statement.

const PATH = "/backoffice/accounts";

type Owing = {
  customer_id: string;
  name: string | null;
  phone: string | null;
  removed: boolean;
  balance: string;
  bills: number;
  oldest: string | null;
  oldest_age: number | null;
  overdue: string;
  overdue_bills: number;
  paid_over: string;
};
type Over = { id: string; number: string; day: string; owed: string; customer_id: string | null; name: string | null };
type Flagged = { kind: "bill" | "payment"; id: string; number: string; at: string; amount: string; customer_id: string | null; name: string | null; flags: { why: string; bill?: string }[] };

export default async function AccountsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (ctx.mode !== "retail") notFound();
  const tab = one(sp.tab) === "exceptions" ? "exceptions" : "owed";
  const q = one(sp.q).trim().slice(0, 60);
  const d = await readTenant(ctx.tenantId, async (c) => {
    const may = await canView(c, ctx.employeeId);
    const s = await loadSettings(c, ctx.tenantId);
    const paid = (await c.query(`select has_feature($1, 'accounts') as ok`, [ctx.tenantId])).rows[0].ok as boolean;
    if (!may) return { may, s, paid, owing: [] as Owing[], over: [] as Over[], flagged: [] as Flagged[], tz: (await lists(c, ctx.tenantId)).tz };
    // every customer with a bill that owes or is paid over: what they owe in all, their open bills, the oldest and how old, what is overdue
    const owing = (
      await c.query(
        `select b.customer_id, cu.name, cu.phone, cu.deleted_at is not null as removed,
                sum(account_owed(b)) as balance,
                count(*) filter (where account_owed(b) > 0)::int as bills,
                min(b.day) filter (where account_owed(b) > 0)::text as oldest,
                max(${ageSql("b")}) filter (where account_owed(b) > 0) as oldest_age,
                coalesce(sum(account_owed(b)) filter (where account_owed(b) > 0 and ${ageSql("b")} > $2), 0) as overdue,
                count(*) filter (where account_owed(b) > 0 and ${ageSql("b")} > $2)::int as overdue_bills,
                coalesce(-sum(account_owed(b)) filter (where account_owed(b) < 0), 0) as paid_over
           from account_bills b
           left join customers cu on cu.tenant_id = b.tenant_id and cu.id = b.customer_id
          where b.tenant_id = $1 and b.deleted_at is null and b.customer_id is not null and account_owed(b) <> 0
          group by b.customer_id, cu.name, cu.phone, cu.deleted_at
          order by sum(account_owed(b)) desc, lower(cu.name)`,
        [ctx.tenantId, s.accountDays],
      )
    ).rows as Owing[];
    const over = (
      await c.query(
        `select b.id, b.number, b.day::text as day, account_owed(b) as owed, b.customer_id, cu.name
           from account_bills b left join customers cu on cu.tenant_id = b.tenant_id and cu.id = b.customer_id
          where b.tenant_id = $1 and b.deleted_at is null and (account_owed(b) < 0 or (b.customer_id is null and account_owed(b) <> 0))
          order by b.day desc limit 300`,
        [ctx.tenantId],
      )
    ).rows as Over[];
    const flagged = (
      await c.query(
        `select * from (
           select 'bill' as kind, b.id, b.number, coalesce(r.device_time, b.created_at) as at, b.amount, b.customer_id, cu.name, b.flags
             from account_bills b
             left join receipts r on r.tenant_id = b.tenant_id and r.id = b.id
             left join customers cu on cu.tenant_id = b.tenant_id and cu.id = b.customer_id
            where b.tenant_id = $1 and b.deleted_at is null and jsonb_array_length(b.flags) > 0
           union all
           select 'payment', q.id, q.number, q.device_time, q.amount, q.customer_id, cu.name, q.flags
             from account_payments q left join customers cu on cu.tenant_id = q.tenant_id and cu.id = q.customer_id
            where q.tenant_id = $1 and jsonb_array_length(q.flags) > 0
         ) x order by x.at desc limit 300`,
        [ctx.tenantId],
      )
    ).rows as Flagged[];
    return { may, s, paid, owing, over, flagged, tz: (await lists(c, ctx.tenantId)).tz };
  });
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const at = clock(d.tz);
  const days = d.s.accountDays;
  const match = (name: string | null, phone?: string | null) =>
    !q || (name ?? "").toLowerCase().includes(q.toLowerCase()) || (q.replace(/\D/g, "").length >= 3 && (phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, "")));
  const owing = d.owing.filter((o) => Number(o.balance) > 0 || o.bills > 0);
  const shown = owing.filter((o) => match(o.name, o.phone));
  const total = owing.reduce((a, o) => a + Math.max(0, Number(o.balance)), 0);
  const overdue = d.owing.filter((o) => Number(o.overdue) > 0);
  const overdueTotal = overdue.reduce((a, o) => a + Number(o.overdue), 0);
  const exceptions = overdue.length + d.over.length + d.flagged.length;
  const tabHref = (t: string) => `${PATH}?${new URLSearchParams({ ...(t === "exceptions" ? { tab: t } : {}), ...(q ? { q } : {}) })}`;
  const who = (id: string | null, name: string | null) => (id ? <Link href={`${PATH}/${id}`}>{name ?? "A customer"}</Link> : <span className="muted">No customer</span>);

  return (
    <div>
      <PageHead title="Accounts" lede="Customers who took goods on account: what each owes, how old it is, and what needs a look. A sale goes on account, and is paid off, at a till.">
        <Link href="/backoffice/settings" className="btn-quiet">Account settings</Link>
      </PageHead>
      <Flash sp={sp} />
      {!d.paid && (
        <div className="note">
          <strong>Customer accounts are an extra for this shop.</strong>Ask EasyPay to add them. Bills already on account stay here and can still be paid at a till.
        </div>
      )}
      {!d.may ? (
        <Empty icon={BookUser} title="Not for this login">Accounts are shown to those allowed to see reports.</Empty>
      ) : (
        <>
          <form method="get" className="inline" style={{ marginBottom: 14 }}>
            {tab === "exceptions" && <input type="hidden" name="tab" value="exceptions" />}
            <span className="seg" style={{ marginRight: 12 }}>
              <Link href={tabHref("owed")} className={tab === "owed" ? "on" : undefined}>Owed</Link>
              <Link href={tabHref("exceptions")} className={tab === "exceptions" ? "on" : undefined}>
                Exceptions{exceptions > 0 ? ` (${exceptions})` : ""}
              </Link>
            </span>
            <input name="q" defaultValue={q} placeholder="Customer or phone" aria-label="Find a customer" />
            <Submit className="btn-quiet btn-sm">Find</Submit>
          </form>
          {tab === "owed" ? (
            <>
              <div className="stats three">
                <Stat label="Total owed" value={m(total)} />
                <Stat label="Customers owing" value={String(owing.length)} />
                <Stat label={`Unpaid past ${days} days`} value={m(overdueTotal)} note={overdue.length ? `${overdue.length} ${overdue.length === 1 ? "customer" : "customers"}` : "Nothing overdue"} />
              </div>
              {shown.length === 0 ? (
                <Empty icon={BookUser} title={q ? `Nobody owing matches “${q}”` : "Nobody owes the shop"}>
                  A sale goes on a customer's account with On account on the till's Pay screen, once the sale names a customer.
                </Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th className="num">Open bills</th>
                      <th>Oldest bill</th>
                      <th className="num">Overdue</th>
                      <th className="num">Balance owed</th>
                      <th>Statement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((o) => (
                      <tr key={o.customer_id}>
                        <td className="strong">
                          {who(o.customer_id, o.name)}
                          {(o.phone || o.removed) && <span className="sub">{[o.phone, o.removed ? "removed from Customers" : null].filter(Boolean).join(" · ")}</span>}
                        </td>
                        <td className="num">{o.bills}</td>
                        <td className={o.oldest_age !== null && o.oldest_age > days ? "neg" : undefined}>
                          {o.oldest ? `${fmtDay(o.oldest)} · ${o.oldest_age} ${o.oldest_age === 1 ? "day" : "days"}` : <span className="muted">None open</span>}
                        </td>
                        <td className={Number(o.overdue) > 0 ? "num neg" : "num"}>{Number(o.overdue) > 0 ? m(o.overdue) : ""}</td>
                        <td className="num strong">
                          {m(o.balance)}
                          {Number(o.paid_over) > 0 && <span className="sub">after {m(o.paid_over)} paid over</span>}
                        </td>
                        <td>
                          <Link href={`${PATH}/${o.customer_id}/statement`}>Statement</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>{shown.length} {shown.length === 1 ? "customer" : "customers"}</td>
                      <td className="num">{shown.reduce((a, o) => a + o.bills, 0)}</td>
                      <td />
                      <td className="num">{m(shown.reduce((a, o) => a + Number(o.overdue), 0))}</td>
                      <td className="num">{m(shown.reduce((a, o) => a + Number(o.balance), 0))}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              )}
            </>
          ) : (
            <>
              <h2>Overdue: unpaid past {days} days</h2>
              {overdue.filter((o) => match(o.name, o.phone)).length === 0 ? (
                <p className="muted">Nothing overdue. Every open bill is within its first {days} days.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>Customer</th><th className="num">Bills overdue</th><th>Since</th><th className="num">Overdue</th></tr>
                  </thead>
                  <tbody>
                    {overdue.filter((o) => match(o.name, o.phone)).map((o) => (
                      <tr key={o.customer_id}>
                        <td className="strong">{who(o.customer_id, o.name)}</td>
                        <td className="num">{o.overdue_bills}</td>
                        <td>{o.oldest ? `${fmtDay(o.oldest)} · ${o.oldest_age} days` : ""}</td>
                        <td className="num neg">{m(o.overdue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <h2>Paid over, or with no customer</h2>
              {d.over.filter((o) => match(o.name)).length === 0 ? (
                <p className="muted">No bill is paid past what it owed, and every bill names its customer.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>Bill</th><th>Customer</th><th>Day</th><th className="num">Paid over</th></tr>
                  </thead>
                  <tbody>
                    {d.over.filter((o) => match(o.name)).map((o) => (
                      <tr key={o.id}>
                        <td className="strong"><Link href={`/backoffice/receipts?q=${encodeURIComponent(o.number)}`}>{o.number}</Link></td>
                        <td>{who(o.customer_id, o.name)}</td>
                        <td>{fmtDay(o.day)}</td>
                        <td className="num">{Number(o.owed) < 0 ? m(-Number(o.owed)) : <span className="muted">{m(o.owed)} owed, no customer</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <h2>To check</h2>
              {d.flagged.filter((f) => match(f.name)).length === 0 ? (
                <p className="muted">Nothing the server could not square.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>What</th><th>Customer</th><th>When</th><th className="num">Amount</th><th>Why</th></tr>
                  </thead>
                  <tbody>
                    {d.flagged.filter((f) => match(f.name)).map((f) => (
                      <tr key={f.kind + f.id}>
                        <td className="strong">
                          {f.kind === "bill" ? <Link href={`/backoffice/receipts?q=${encodeURIComponent(f.number)}`}>{f.number}</Link> : f.number}
                          <span className="sub">{f.kind === "bill" ? "Sale on account" : "Account payment"}</span>
                        </td>
                        <td>{who(f.customer_id, f.name)}</td>
                        <td>{at(f.at)}</td>
                        <td className="num">{m(f.amount)}</td>
                        <td>{[...new Set(f.flags.map((x) => (FLAG[x.why] ?? x.why) + (x.bill && f.kind === "payment" ? ` (${x.bill})` : "")))].join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
