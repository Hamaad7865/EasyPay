import { Percent } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { args, canView, filters, fmtDay, lists, RECEIPTS } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters, Stat } from "../parts";

type Row = { name: string; rate_bp: number; type: string; receipts: number; amount: string; tax: string };

// Each line's share of the bill's discount comes off before the tax is worked
// out, the same way the till and the server do it for the receipt.
const SQL = `
  with r as (${RECEIPTS}),
  l as (
    select r.id as receipt_id, r.sign, rl.id as line_id, r.subtotal, r.discount_total,
           (line_amount(rl.unit_price, rl.qty) + coalesce((select sum(m.price) from receipt_line_modifiers m
              where m.tenant_id = $1 and m.receipt_line_id = rl.id), 0))::bigint as base
      from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
  ),
  x as (select l.*, l.base - case when l.subtotal > 0 then l.discount_total * l.base / l.subtotal else 0 end as net from l)
  select coalesce(t.name_snapshot, 'No tax set') as name, coalesce(t.rate_bp, 0)::int as rate_bp, coalesce(t.type, 'included') as type,
         count(distinct x.receipt_id)::int as receipts,
         coalesce(sum(x.sign * x.net), 0)::bigint as amount,
         coalesce(sum(x.sign * case when t.rate_bp is null then 0
                when t.type = 'added' then (x.net * t.rate_bp + 5000) / 10000
                else (x.net * t.rate_bp + (10000 + t.rate_bp) / 2) / (10000 + t.rate_bp) end), 0)::bigint as tax
    from x left join receipt_line_taxes t on t.tenant_id = $1 and t.receipt_line_id = x.line_id
   where ($7::uuid is null or t.tax_id = $7::uuid)
   group by 1, 2, 3 order by 2 desc, 1`;

export default async function TaxReport({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => {
    const l = await lists(c, ctx.tenantId);
    const f = { ...filters(sp, l.tz), kind: "all" as const };
    if (!(await canView(c, ctx.employeeId))) return { l, f, ok: false as const };
    const rows = (await c.query(SQL, [...args(ctx.tenantId, f), f.tax])).rows as Row[];
    const t = (await c.query(`select name, brn, vat_number from tenants where id = $1`, [ctx.tenantId])).rows[0] as { name: string; brn: string | null; vat_number: string | null };
    return { l, f, ok: true as const, s: await loadSettings(c, ctx.tenantId), rows, t };
  });
  const head = <PageHead title="Tax" lede="Sales and the VAT in them, split by tax type: what the VAT return asks for. Refunds are taken off." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number) => money(Number(v), 2);
  const rows = d.rows.map((r) => {
    const amount = Number(r.amount), tax = Number(r.tax);
    return { ...r, excl: r.type === "added" ? amount : amount - tax, tax, incl: r.type === "added" ? amount + tax : amount };
  });
  const sum = (k: "excl" | "tax" | "incl") => rows.reduce((a, r) => a + r[k], 0);
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/tax" f={d.f} l={d.l} show={["tax"]} />
      {rows.length === 0 ? (
        <Empty icon={Percent} title="No sales in these days">Pick other dates.</Empty>
      ) : (
        <>
          <p className="muted">
            {d.t.name}{d.t.brn ? ` · BRN ${d.t.brn}` : ""}{d.t.vat_number ? ` · VAT ${d.t.vat_number}` : ""} · {fmtDay(d.f.from)} to {fmtDay(d.f.to)}
          </p>
          <div className="stats">
            <Stat label="Sales excluding VAT" value={m(sum("excl"))} />
            <Stat label="VAT" value={m(sum("tax"))} />
            <Stat label="Sales including VAT" value={m(sum("incl"))} />
            <Stat label="Tax types" value={String(rows.length)} />
          </div>
          <table>
            <thead>
              <tr><th>VAT type</th><th className="num">Rate</th><th>Menu prices</th><th className="num">Receipts</th><th className="num">Excluding VAT</th><th className="num">VAT</th><th className="num">Including VAT</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="strong">{r.name === "No tax set" ? <span className="badge amber">No tax set on the item</span> : r.name}</td>
                  <td className="num">{(r.rate_bp / 100).toString()}%</td>
                  <td>{r.rate_bp === 0 ? <span className="muted">No VAT charged</span> : r.type === "added" ? "VAT added on top" : "VAT included"}</td>
                  <td className="num">{r.receipts}</td>
                  <td className="num">{m(r.excl)}</td>
                  <td className="num strong">{m(r.tax)}</td>
                  <td className="num">{m(r.incl)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Total</td><td /><td /><td /><td className="num">{m(sum("excl"))}</td><td className="num">{m(sum("tax"))}</td><td className="num">{m(sum("incl"))}</td></tr>
            </tfoot>
          </table>
          <p className="muted">VAT is worked out line by line after each line&apos;s share of the bill discount, so a total can differ from the sum of the receipts by a few cents of rounding.</p>
        </>
      )}
    </div>
  );
}
