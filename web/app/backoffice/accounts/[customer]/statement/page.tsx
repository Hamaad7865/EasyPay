import Link from "next/link";
import { notFound } from "next/navigation";
import { BookUser } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { canView, fmtDay, lists, today } from "@/lib/report";
import { aged, ageSql, BUCKETS, type Bill } from "@/lib/accounts";
import { Empty, type Search } from "../../../ui";
import { PrintButton } from "../../../reports/print-button";

// A customer's statement of account (migration 0114), on one A4 page as
// Carfectionist prints it: the shop, the customer, what is owed aged by how
// old each bill is, and every bill that still owes. The browser prints it or
// saves it as a PDF; nothing is sent from here.

export default async function StatementPage({ params, searchParams }: { params: Promise<{ customer: string }>; searchParams: Search }) {
  const { customer } = await params;
  await searchParams;
  const ctx = await tenantContext();
  if (ctx.mode !== "retail" || !UUID.test(customer)) notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const may = await canView(c, ctx.employeeId);
    const who = (await c.query(`select name, phone, email from customers where tenant_id = $1 and id = $2`, [ctx.tenantId, customer])).rows[0] as
      | { name: string; phone: string | null; email: string | null }
      | undefined;
    const s = await loadSettings(c, ctx.tenantId);
    const tz = (await lists(c, ctx.tenantId)).tz;
    // who the shop is on paper, as Company details keeps it
    const t = (await c.query(`select name, brn, vat_number from tenants where id = $1`, [ctx.tenantId])).rows[0] as { name: string; brn: string | null; vat_number: string | null };
    const shop = { name: t.name, brn: t.brn ?? s.company.brn, vat: t.vat_number ?? s.company.vat, address: s.company.address, phone: s.company.phone };
    const bills = may && who
      ? ((
          await c.query(
            `select b.id, b.number, b.day::text as day, b.amount, b.paid, b.returned, account_owed(b) as owed, ${ageSql("b")} as age, b.customer_id, b.flags
               from account_bills b
              where b.tenant_id = $1 and b.customer_id = $2 and b.deleted_at is null and account_owed(b) <> 0
              order by b.day, b.number`,
            [ctx.tenantId, customer],
          )
        ).rows as Bill[])
      : [];
    return { may, who, s, tz, shop, bills };
  });
  if (!d.who) notFound();
  if (!d.may) return <Empty icon={BookUser} title="Not for this login">Statements are shown to those allowed to see reports.</Empty>;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const co = d.shop;
  const name = co.name;
  const asAt = fmtDay(today(d.tz));
  const balance = d.bills.reduce((a, b) => a + Number(b.owed), 0);
  const buckets = aged(d.bills);
  return (
    <div>
      <div className="bo-toolbar no-print" style={{ marginBottom: 16 }}>
        <Link href={`/backoffice/accounts/${customer}`} className="btn-quiet">Back to the account</Link>
        <PrintButton />
      </div>
      <article className="statement">
        <header className="st-head">
          <div>
            <div className="st-shop">{name}</div>
            {co.address && <div>{co.address}</div>}
            <div>{[co.phone, co.brn && `BRN ${co.brn}`, co.vat && `VAT ${co.vat}`].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="st-title">
            <div>STATEMENT OF ACCOUNT</div>
            <small>As at {asAt}</small>
          </div>
        </header>
        <section className="st-to">
          <small>Account</small>
          <div className="st-who">{d.who.name}</div>
          <div>{[d.who.phone, d.who.email].filter(Boolean).join(" · ")}</div>
        </section>
        <h3>Balance, aged</h3>
        <table>
          <thead>
            <tr>
              <th>Owed</th>
              {BUCKETS.map((b) => <th key={b.key} className="num">{b.label}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="strong">{m(balance)}</td>
              {buckets.map((v, i) => <td key={i} className="num">{v ? m(v) : "—"}</td>)}
            </tr>
          </tbody>
        </table>
        <h3>Bills on account</h3>
        <table>
          <thead>
            <tr><th>Date</th><th>Bill</th><th className="num">On account</th><th className="num">Paid or returned</th><th className="num">Still owed</th></tr>
          </thead>
          <tbody>
            {d.bills.map((b) => (
              <tr key={b.id}>
                <td>{fmtDay(b.day)}</td>
                <td>{b.number}</td>
                <td className="num">{m(b.amount)}</td>
                <td className="num">{Number(b.paid) + Number(b.returned) ? m(Number(b.paid) + Number(b.returned)) : "—"}</td>
                <td className="num">{Number(b.owed) < 0 ? `(${m(-Number(b.owed))})` : m(b.owed)}</td>
              </tr>
            ))}
            {d.bills.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ textAlign: "center" }}>Nothing is owed.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr><td colSpan={4}>Balance owed</td><td className="num">{m(balance)}</td></tr>
          </tfoot>
        </table>
        <p className="st-foot">
          This statement shows the bills on account not yet paid in full as at {asAt}
          {d.bills.some((b) => Number(b.owed) < 0) ? "; a figure in brackets was paid over, and is owed to you by the shop" : ""}. Please bring it when you pay.
        </p>
      </article>
    </div>
  );
}
