import Link from "next/link";
import { notFound } from "next/navigation";
import { Contact } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { money } from "@/lib/settings";
import { clock, fmtDay, fmtQty, reportStart } from "@/lib/report";
import { Card, Empty, PageHead, type Search } from "../../ui";
import { Stat } from "../../reports/parts";
import { ReceiptCard, type ReceiptHead, receiptParts } from "../../receipt-card";

// One customer's history (2026-10-26): how often they came, what they spent
// and buy most, and every receipt and refund on an order they were put on.
// A receipt is theirs by its order (tickets.customer_id), as Customers counts
// Spent, so the two say the same. The figures and receipts are a report's:
// shown to those allowed to see reports.

const LIMIT = 200;

type Who = { name: string; phone: string | null; email: string | null; note: string | null; card: string | null; points: string; removed: boolean };
type Sums = { visits: number; receipts: number; spent: string; first: string | null; last: string | null };
type Head = ReceiptHead & { store: string | null; points_earned: string; points_used: string };

// the receipts that are this customer's ($1 the tenant, $2 the customer), with what a query joins to them
const theirs = (joins = "") => `receipts r join tickets t on t.tenant_id = r.tenant_id and t.id = r.ticket_id ${joins}
   where r.tenant_id = $1 and t.customer_id = $2 and r.deleted_at is null`;

export default async function CustomerHistory({ params, searchParams }: { params: Promise<{ customer: string }>; searchParams: Search }) {
  const { customer } = await params;
  await searchParams;
  const ctx = await tenantContext();
  if (!UUID.test(customer)) notFound();
  const shop = ctx.mode === "retail";
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const who = (
      await c.query(`select name, phone, email, note, card, points, deleted_at is not null as removed from customers where tenant_id = $1 and id = $2`, [ctx.tenantId, customer])
    ).rows[0] as Who | undefined;
    if (!who || !ok) return { l, ok, s, who, sums: null, most: [], heads: [] as Head[], parts: null, stores: 1, has: null };
    const sums = (
      await c.query(
        `select count(distinct r.ticket_id) filter (where r.type = 'sale')::int as visits, count(*)::int as receipts,
                coalesce(sum(case when r.type = 'refund' then -r.total else r.total end), 0) as spent,
                (min(coalesce(r.device_time, r.created_at)) filter (where r.type = 'sale') at time zone $3)::date::text as first,
                (max(coalesce(r.device_time, r.created_at)) filter (where r.type = 'sale') at time zone $3)::date::text as last
           from ${theirs()}`,
        [ctx.tenantId, customer, l.tz],
      )
    ).rows[0] as Sums;
    // what they took home most: the sales' lines less what came back
    const most = (
      await c.query(
        `select rl.name_snapshot as name, sum(case when r.type = 'refund' then -rl.qty else rl.qty end)::bigint as qty
           from ${theirs("join receipt_lines rl on rl.tenant_id = r.tenant_id and rl.receipt_id = r.id")}
          group by rl.name_snapshot having sum(case when r.type = 'refund' then -rl.qty else rl.qty end) > 0
          order by 2 desc, 1 limit 5`,
        [ctx.tenantId, customer],
      )
    ).rows as { name: string; qty: string }[];
    const heads = (
      await c.query(
        `select r.id, r.number, r.type, coalesce(r.device_time, r.created_at) as at, r.subtotal, r.discount_total, r.tax_total, r.rounding, r.total,
                r.needs_review, t.name as order_name, t.covers, t.note, e.name as cashier, w.name as waiter, o.name as dining, tb.name as table_name,
                (select x.number from receipts x where x.tenant_id = $1 and x.id = r.refund_of) as refund_number,
                st.name as store, r.points_earned, r.points_used
           from ${theirs(`
           left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
           left join employees w on w.tenant_id = r.tenant_id and w.id = t.opened_by
           left join dining_options o on o.tenant_id = r.tenant_id and o.id = t.dining_option_id
           left join tables tb on tb.tenant_id = r.tenant_id and tb.id = t.table_id
           left join stores st on st.tenant_id = r.tenant_id and st.id = r.store_id`)}
          order by coalesce(r.device_time, r.created_at) desc limit ${LIMIT}`,
        [ctx.tenantId, customer],
      )
    ).rows as Head[];
    const stores = (await c.query(`select count(*)::int as n from stores where tenant_id = $1 and deleted_at is null`, [ctx.tenantId])).rows[0].n as number;
    // a shop's other pages about them, each only when there is something on it
    const has = shop
      ? ((
          await c.query(
            `select exists (select 1 from account_bills where tenant_id = $1 and customer_id = $2 and deleted_at is null) as account,
                    exists (select 1 from deposits where tenant_id = $1 and customer_id = $2 and deleted_at is null) as deposits,
                    exists (select 1 from credit_notes where tenant_id = $1 and customer_id = $2) as notes`,
            [ctx.tenantId, customer],
          )
        ).rows[0] as { account: boolean; deposits: boolean; notes: boolean })
      : null;
    return { l, ok, s, who, sums, most, heads, parts: await receiptParts(c, ctx.tenantId, heads.map((h) => h.id)), stores, has };
  });
  if (!d.who) notFound();
  const who = d.who;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const find = encodeURIComponent(who.phone?.trim() || who.name);
  const head = (
    <PageHead
      title={who.name}
      lede={[who.phone, who.email, who.card ? `card ${who.card}` : null, who.note, who.removed ? "removed from Customers; their receipts stay" : null].filter(Boolean).join(" · ") || undefined}
    >
      <Link href="/backoffice/customers" className="btn-quiet">All customers</Link>
      {d.has?.account && <Link href={`/backoffice/accounts/${customer}`} className="btn-quiet">Account</Link>}
      {d.has?.deposits && <Link href={`/backoffice/deposits?show=all&q=${find}`} className="btn-quiet">Deposits</Link>}
      {d.has?.notes && <Link href={`/backoffice/credit-notes?q=${encodeURIComponent(who.name)}`} className="btn-quiet">Credit notes</Link>}
    </PageHead>
  );
  if (!d.ok) return <div>{head}<Empty icon={Contact} title="Not for this login">A customer's visits and receipts are shown to those allowed to see reports.</Empty></div>;
  const sums = d.sums!;
  if (sums.receipts === 0) return <div>{head}<Empty icon={Contact} title="Nothing bought yet">Once a cashier puts {who.name} on an order and it is paid, it shows here.</Empty></div>;
  const spent = Number(sums.spent);
  const loyal = d.s.loyalty === "on" || Number(who.points) !== 0;
  const at = clock(d.l.tz);
  // what each receipt did to the points: a sale earns and uses, a refund takes back and gives back
  const points = (h: Head) => {
    const e = Number(h.points_earned), u = Number(h.points_used);
    const said = h.type === "refund"
      ? [e < 0 ? `${m(-e)} taken back` : "", u < 0 ? `${m(-u)} given back` : ""]
      : [e > 0 ? `${m(e)} earned` : "", u > 0 ? `${m(u)} used` : ""];
    const words = said.filter(Boolean).join(", ");
    return words ? `points: ${words}` : null;
  };
  return (
    <div>
      {head}
      <div className="stats">
        <Stat label="Visits" value={String(sums.visits)} note={sums.first ? `first on ${fmtDay(sums.first)}` : undefined} />
        <Stat label="Spent" value={m(spent)} note={loyal ? `${m(who.points)} in points to spend` : undefined} />
        <Stat label="Average per visit" value={sums.visits ? m(Math.round(spent / sums.visits)) : "None"} />
        <Stat label="Last visit" value={sums.last ? fmtDay(sums.last) : "None"} />
      </div>
      {d.most.length > 0 && (
        <Card title="Buys most" lede="What they took home most, what came back taken off" flush>
          <table>
            <thead><tr><th>Item</th><th className="num">Qty</th></tr></thead>
            <tbody>
              {d.most.map((x) => <tr key={x.name}><td className="strong">{x.name}</td><td className="num">{fmtQty(Number(x.qty))}</td></tr>)}
            </tbody>
          </table>
        </Card>
      )}
      <h2 style={{ margin: "24px 0 4px" }}>Receipts</h2>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        {sums.receipts > d.heads.length ? `The latest ${d.heads.length} of ${sums.receipts}, newest first.` : "Every sale and refund, newest first."} Open one to see it in full.
      </p>
      {d.heads.map((h) => (
        <ReceiptCard key={h.id} h={h} parts={d.parts!} m={m} at={at} more={[d.stores > 1 ? h.store : null, points(h)].filter((x): x is string => Boolean(x))} />
      ))}
    </div>
  );
}
