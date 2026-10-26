import Link from "next/link";
import { notFound } from "next/navigation";
import { PackageCheck } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant, withTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { canView, clock, lists } from "@/lib/report";
import { Card, Empty, Flash, one, PageHead, type Search } from "../ui";
import { Submit } from "../busy";
import { stillOpen, toPaySql } from "@/lib/deposits";

// A shop's deposits (migration 0113): goods held for a customer who paid part,
// collected later. Taken, paid on, collected and cancelled at a till, where
// the money and the goods are; this page shows them. Opening it cancels, for
// a shop set to, the deposits past their date and grace (deposits_expire), as
// a till's pull does: nothing runs nightly.

const PATH = "/backoffice/deposits";

type Row = {
  id: string;
  // the branch it was taken at
  branch: string;
  number: string;
  status: "open" | "collected" | "cancelled";
  collect_by: string;
  total: string;
  paid: string;
  given_back: string;
  used: string;
  kept: string;
  owed: string;
  noted: string;
  free: string;
  to_pay: string;
  cancel_outcome: string | null;
  cancel_reason: string | null;
  auto_cancelled: boolean;
  device_time: string;
  cancelled_at: string | null;
  customer: string | null;
  phone: string | null;
  till: string | null;
  taken_by: string | null;
  overdue: number;
  flags: { why: string }[];
  note_no: string | null;
};
type Line = { name: string; qty: number; qty_collected: number; unit_price: string; price_label: string | null };
type Pay = { kind: string; amount: string; method: string | null; device_time: string; who: string | null };
type Rc = { id: string; number: string; total: string; device_time: string };

const FLAG: Record<string, string> = {
  "not-entitled": "Taken before the shop had deposits",
  "customer-unknown": "Its customer was not known to the server",
  "number-collision": "Its number was taken: the server gave it another",
  "price-unapproved": "A price on it was changed by someone not allowed to",
  "closed-payment": "Money was taken on it after it was closed",
  "cancel-unapproved": "Cancelled by someone not allowed to refund",
  "auto-early": "Sent as cancelled by its date before its date and grace were past",
  "over-given": "More was given back than was free on it",
  "note-differs": "Its credit note is not what was free on it",
  "cancelled-twice": "Cancelled at two tills",
};

export default async function DepositsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (ctx.mode !== "retail") notFound();
  const show = one(sp.show) === "all" ? "all" : "open";
  const q = one(sp.q).trim().slice(0, 60);
  const openId = one(sp.id);
  // what is past its date is cancelled first, for a shop set to (its own transaction: this page only reads)
  await withTenant(ctx.tenantId, (c) => c.query(`select deposits_expire($1)`, [ctx.tenantId])).catch(() => null);
  const d = await readTenant(ctx.tenantId, async (c) => {
    const may = await canView(c, ctx.employeeId);
    const paid = (await c.query(`select has_feature($1, 'deposits') as ok`, [ctx.tenantId])).rows[0].ok as boolean;
    const rows = may
      ? ((
          await c.query(
            `select x.id, x.number, x.status, x.collect_by::text as collect_by, x.total, x.paid, x.given_back, x.used, x.kept, x.owed, x.noted,
                    deposit_free(x) as free,
                    -- what the goods not collected yet come to, less what is free on it (the till's DepositRules.toPay)
                    ${toPaySql("x")} as to_pay,
                    x.cancel_outcome, x.cancel_reason, x.auto_cancelled, x.device_time, x.cancelled_at, x.flags,
                    cu.name as customer, cu.phone, pd.name as till, e.name as taken_by, cn.number as note_no, st.name as branch,
                    greatest(0, deposit_today(x.tenant_id, x.store_id) - x.collect_by) as overdue
               from deposits x
               left join customers cu on cu.tenant_id = x.tenant_id and cu.id = x.customer_id
               left join pos_devices pd on pd.tenant_id = x.tenant_id and pd.id = x.device_id
               left join employees e on e.tenant_id = x.tenant_id and e.id = x.created_by
               left join credit_notes cn on cn.tenant_id = x.tenant_id and cn.id = x.credit_note_id
               join stores st on st.tenant_id = x.tenant_id and st.id = x.store_id
              where x.tenant_id = $1 and x.deleted_at is null
                and ($2 = 'all' or $3 <> '' or ${stillOpen("x")})
                and ($3 = '' or x.number ilike '%' || $3 || '%' or cu.name ilike '%' || $3 || '%' or cu.phone ilike '%' || $3 || '%')
              order by (x.status = 'open') desc, x.owed > 0 desc, x.collect_by, x.device_time desc limit 300`,
            [ctx.tenantId, show, q],
          )
        ).rows as Row[])
      : [];
    const pick = rows.find((r) => r.id === openId) ?? (rows.length === 1 ? rows[0] : null);
    const detail = pick
      ? {
          lines: (await c.query(`select name, qty, qty_collected, unit_price, price_label from deposit_lines where tenant_id = $1 and deposit_id = $2 order by sort`, [ctx.tenantId, pick.id])).rows as Line[],
          pays: (
            await c.query(
              `select q.kind, q.amount, pt.name as method, q.device_time, e.name as who from deposit_payments q
                 left join payment_types pt on pt.tenant_id = q.tenant_id and pt.id = q.payment_type_id
                 left join employees e on e.tenant_id = q.tenant_id and e.id = q.employee_id
                where q.tenant_id = $1 and q.deposit_id = $2 order by q.device_time`,
              [ctx.tenantId, pick.id],
            )
          ).rows as Pay[],
          receipts: (
            await c.query(
              `select distinct r.id, r.number, r.total, r.device_time from receipts r
                 join receipt_payments p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                 join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind = 'deposit'
                where r.tenant_id = $1 and p.reference = $2 and r.deleted_at is null
               union
               select distinct r.id, r.number, r.total, r.device_time from receipts r
                 join receipt_lines rl on rl.tenant_id = r.tenant_id and rl.receipt_id = r.id
                 join ticket_lines tl on tl.tenant_id = r.tenant_id and tl.id = rl.ticket_line_id
                 join deposit_lines dl on dl.tenant_id = tl.tenant_id and dl.id = tl.deposit_line_id and dl.deposit_id = $3
                where r.tenant_id = $1 and r.deleted_at is null and r.type = 'sale'
                order by device_time`,
              [ctx.tenantId, pick.number, pick.id],
            )
          ).rows as Rc[],
        }
      : null;
    return { may, paid, rows, pick, detail, l: await lists(c, ctx.tenantId), s: await loadSettings(c, ctx.tenantId) };
  });
  const at = clock(d.l.tz);
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const toPay = (r: Row) => Number(r.to_pay);
  const state = (r: Row) =>
    r.status === "open"
      ? r.overdue > 0
        ? `Overdue ${r.overdue} ${r.overdue === 1 ? "day" : "days"}`
        : "Open"
      : Number(r.owed) > 0
        ? `${m(r.owed)} to give back`
        : r.status === "collected"
          ? Number(r.free) > 0
            ? `Collected · ${m(r.free)} paid over`
            : "Collected"
          : `Cancelled${r.auto_cancelled ? " by date" : ""}`;
  const outcome = (r: Row) =>
    r.cancel_outcome === "credit"
      ? `${m(r.noted)} on credit note ${r.note_no ?? ""}`
      : r.cancel_outcome === "keep"
        ? `${m(r.kept)} kept by the shop`
        : r.cancel_outcome === "refund"
          ? `${m(r.given_back)} given back` + (Number(r.owed) > 0 ? `, ${m(r.owed)} still owed` : "")
          : null;
  const href = (o: Record<string, string>) => `${PATH}?${new URLSearchParams({ ...(show === "all" ? { show } : {}), ...(q ? { q } : {}), ...o })}`;
  const open = d.rows.filter((r) => r.status === "open");
  // a customer's deposit is the account's, whichever branch took it: with several, each says which (the spec's section 3)
  const many = d.l.stores.length > 1;
  return (
    <div>
      <PageHead
        title="Deposits"
        lede="Goods held for customers who paid part, at the price of the day they were taken. A deposit is taken, paid on, collected and cancelled at a till, where the money and the goods are."
      >
        <Link href="/backoffice/settings" className="btn-quiet">Deposit settings</Link>
      </PageHead>
      <Flash sp={sp} />
      {!d.paid && (
        <div className="note">
          <strong>Deposits are an extra for this shop.</strong>Ask EasyPay to add them. Deposits already taken stay here and can still be paid, collected and cancelled at a till.
        </div>
      )}
      {!d.may ? (
        <Empty icon={PackageCheck} title="Not for this login">Deposits are shown to those allowed to see reports.</Empty>
      ) : (
        <>
          <form method="get" className="inline" style={{ marginBottom: 14 }}>
            <input type="hidden" name="show" value={show} />
            <input name="q" defaultValue={q} placeholder="Number, customer or phone" aria-label="Find a deposit" />
            <Submit className="btn-quiet btn-sm">Find</Submit>
            <span className="seg" style={{ marginLeft: 12 }}>
              <Link href={`${PATH}?show=open${q ? "&q=" + encodeURIComponent(q) : ""}`} className={show === "open" ? "on" : undefined}>Open</Link>
              <Link href={`${PATH}?show=all${q ? "&q=" + encodeURIComponent(q) : ""}`} className={show === "all" ? "on" : undefined}>All</Link>
            </span>
          </form>
          {show === "open" && open.length > 0 && (
            <div className="note">
              <strong>
                {open.length} open {open.length === 1 ? "deposit" : "deposits"}: {m(open.reduce((a, r) => a + Math.max(0, Number(r.free)), 0))} paid and not yet used,{" "}
                {m(open.reduce((a, r) => a + toPay(r), 0))} still to pay
              </strong>
              The money paid is the customers' until the goods are collected. The goods are off the shelf.
            </div>
          )}
          {d.rows.length === 0 ? (
            <Empty icon={PackageCheck} title={q ? `No deposit matches “${q}”` : "No open deposits"}>
              A deposit is taken at a till: the goods are rung up on Sell, then Deposit.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Customer</th>
                  {many && <th>Branch</th>}
                  <th>Taken</th>
                  <th>Collect by</th>
                  <th className="num">Total</th>
                  <th className="num">Paid</th>
                  <th className="num">To pay</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id} className={d.pick?.id === r.id ? "on" : undefined}>
                    <td className="strong">
                      <Link href={href({ id: r.id })}>{r.number}</Link>
                    </td>
                    <td>
                      {r.customer ?? <span className="muted">Not named</span>}
                      {r.phone && <span className="sub">{r.phone}</span>}
                    </td>
                    {many && <td>{r.branch}</td>}
                    <td>
                      {at(r.device_time)}
                      <span className="sub">{[r.till, r.taken_by].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td>{r.collect_by}</td>
                    <td className="num">{m(r.total)}</td>
                    <td className="num">
                      {m(r.paid)}
                      {Number(r.given_back) > 0 && <span className="sub">{m(r.given_back)} given back</span>}
                    </td>
                    <td className="num strong">{r.status === "open" ? m(toPay(r)) : ""}</td>
                    <td className={r.status === "open" && r.overdue > 0 ? "neg" : undefined}>
                      {state(r)}
                      {r.flags.length > 0 && <span className="sub">Check: {r.flags.map((f) => FLAG[f.why] ?? f.why).join("; ")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.pick && d.detail && (
            <Card title={`${d.pick.number} · ${d.pick.customer ?? "No customer"}`} lede={[state(d.pick), d.pick.cancel_reason, outcome(d.pick)].filter(Boolean).join(" · ")}>
              <div className="grid-2">
                <div>
                  <h3 style={{ marginTop: 0 }}>Goods</h3>
                  <table>
                    <tbody>
                      {d.detail.lines.map((l, i) => (
                        <tr key={i}>
                          <td>
                            {l.qty / 1000} × {l.name}
                            {l.price_label && <span className="sub">{l.price_label}</span>}
                          </td>
                          <td>{l.qty_collected > 0 ? `${l.qty_collected / 1000} collected` : ""}</td>
                          <td className="num">{m(Math.round((Number(l.unit_price) * l.qty) / 1000))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h3 style={{ marginTop: 0 }}>Money</h3>
                  <table>
                    <tbody>
                      {d.detail.pays.map((p, i) => (
                        <tr key={i}>
                          <td>
                            {p.kind === "back" ? "Given back" : "Paid"}, {p.method ?? "Unknown"}
                            <span className="sub">{[at(p.device_time), p.who].filter(Boolean).join(" · ")}</span>
                          </td>
                          <td className="num">{m(p.amount)}</td>
                        </tr>
                      ))}
                      {d.detail.receipts.map((r) => (
                        <tr key={r.id}>
                          <td>
                            Collected on <Link href={`/backoffice/receipts?q=${encodeURIComponent(r.number)}`}>{r.number}</Link>
                            <span className="sub">{at(r.device_time)}</span>
                          </td>
                          <td className="num">{m(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
