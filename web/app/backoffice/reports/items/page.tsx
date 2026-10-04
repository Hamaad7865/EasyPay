import { ListOrdered } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { args, canView, filters, fmtQty, lists, RECEIPTS } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters, Stat } from "../parts";

type Row = { name: string; cat: string | null; qty: number; amount: string };

export default async function ItemRank({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => {
    const l = await lists(c, ctx.tenantId);
    const f = filters(sp, l.tz);
    if (!(await canView(c, ctx.employeeId))) return { l, f, ok: false as const };
    const by = f.group === "category" ? `coalesce(c.name, 'No category')` : `rl.name_snapshot`;
    const rows = (
      await c.query(
        `with r as (${RECEIPTS})
         select ${by} as name, ${f.group === "category" ? "null::text" : "max(c.name)"} as cat,
                sum(r.sign * rl.qty)::int as qty,
                sum(r.sign * (line_amount(rl.unit_price, rl.qty) + coalesce((select sum(m.price) from receipt_line_modifiers m
                   where m.tenant_id = $1 and m.receipt_line_id = rl.id), 0)))::bigint as amount
           from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
           left join ticket_lines tl on tl.tenant_id = $1 and tl.id = rl.ticket_line_id
           left join items i on i.tenant_id = $1 and i.id = tl.item_id
           left join categories c on c.tenant_id = $1 and c.id = i.category_id
          group by 1 order by 4 desc, 1`,
        args(ctx.tenantId, f),
      )
    ).rows as Row[];
    return { l, f, ok: true as const, s: await loadSettings(c, ctx.tenantId), rows };
  });
  const head = <PageHead title="Item sales" lede="What sells, ranked by what it brought in. Amounts are menu prices with add-ons, before any discount on the bill; refunds are taken off." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const total = d.rows.reduce((a, r) => a + Number(r.amount), 0);
  const qty = d.rows.reduce((a, r) => a + r.qty, 0);
  const top = Math.max(1, ...d.rows.map((r) => Number(r.amount)));
  const byCat = d.f.group === "category";
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/items" f={d.f} l={d.l} show={["employee", "group"]} />
      {d.rows.length === 0 ? (
        <Empty icon={ListOrdered} title="Nothing was sold in these days">Pick other dates, or clear the filters.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label={byCat ? "Categories sold" : "Different items sold"} value={String(d.rows.length)} />
            <Stat label="Quantity sold" value={fmtQty(qty)} />
            <Stat label="Sales" value={m(total)} />
            <Stat label="Best seller" value={d.rows[0].name} note={m(d.rows[0].amount)} />
          </div>
          <table>
            <thead>
              <tr>
                <th className="num">Rank</th>
                <th>{byCat ? "Category" : "Item"}</th>
                {!byCat && <th>Category</th>}
                <th className="num">Quantity</th>
                <th className="num">Sales</th>
                <th className="num">Share</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, i) => (
                <tr key={r.name + i}>
                  <td className="num muted">{i + 1}</td>
                  <td className="strong">{r.name}</td>
                  {!byCat && <td>{r.cat ?? <span className="muted">None</span>}</td>}
                  <td className="num">{fmtQty(r.qty)}</td>
                  <td className="num strong">{m(r.amount)}</td>
                  <td className="num">{total > 0 ? ((Number(r.amount) / total) * 100).toFixed(1) : "0.0"}%</td>
                  <td style={{ width: "22%" }}><span className="bar"><i style={{ width: `${Math.max(0, (Number(r.amount) / top) * 100)}%` }} /></span></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td /><td>Total</td>{!byCat && <td />}<td className="num">{fmtQty(qty)}</td><td className="num">{m(total)}</td><td className="num">100%</td><td /></tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
