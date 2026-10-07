import { ListOrdered } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { args, filters, fmtQty, RECEIPTS, reportStart } from "@/lib/report";
import { margin } from "@/lib/stock";
import { itemSalesSql } from "@/lib/stock-reports";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters, Stat } from "../parts";

// ex_vat, costed and cost: a shop's, for whoever may see costs (see itemSalesSql)
type Row = { name: string; cat: string | null; qty: number; amount: string; ex_vat?: string; costed?: string; cost?: string | null };
const pct = (v: number | null) => (v === null ? "" : (v * 100).toFixed(1) + "%");

export default async function ItemRank({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const shop = ctx.mode === "retail";
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz);
    if (!ok) return { l, f, ok: false as const };
    // a shop's cost and profit, for whoever may see them. A restaurant's page asks what it always asked.
    const costs = shop && Boolean((await c.query(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId])).rows[0]?.ok);
    const rows = (await c.query(itemSalesSql(RECEIPTS, f.group === "category", costs), args(ctx.tenantId, f))).rows as Row[];
    return { l, f, ok: true as const, s, rows, costs };
  });
  const head = (
    <PageHead
      title="Item sales"
      lede={
        shop
          ? "What sells, ranked by what it brought in. Sales are shelf prices, before any discount on the bill; refunds are taken off."
          : "What sells, ranked by what it brought in. Amounts are menu prices with add-ons, before any discount on the bill; refunds are taken off."
      }
    />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const total = d.rows.reduce((a, r) => a + Number(r.amount), 0);
  const qty = d.rows.reduce((a, r) => a + r.qty, 0);
  const top = Math.max(1, ...d.rows.map((r) => Number(r.amount)));
  const byCat = d.f.group === "category";
  // profit is over the sales that have a cost: a product with none is not all profit
  const sum = (k: "ex_vat" | "costed" | "cost") => d.rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const exVat = sum("ex_vat"), costed = sum("costed"), cost = sum("cost");
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
            {d.costs && <Stat label="Profit" value={m(costed - cost)} note={margin(costed, cost) === null ? undefined : `${pct(margin(costed, cost))} of sales without VAT`} />}
          </div>
          {d.costs && (
            <p className="muted">
              Profit is sales without VAT, after the bill's discount, less what the goods cost when they were sold.
              {exVat !== costed && ` ${m(exVat - costed)} of these sales have no cost on file (products not counted in stock, or never given a cost): they are in no cost and no profit.`}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th className="num">Rank</th>
                <th>{byCat ? "Category" : "Item"}</th>
                {!byCat && <th>Category</th>}
                <th className="num">Quantity</th>
                <th className="num">Sales</th>
                <th className="num">Share</th>
                {d.costs ? (
                  <>
                    <th className="num">Without VAT</th>
                    <th className="num">Cost</th>
                    <th className="num">Profit</th>
                    <th className="num">Margin</th>
                  </>
                ) : (
                  <th />
                )}
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
                  {d.costs ? (
                    <>
                      <td className="num">{m(r.ex_vat ?? 0)}</td>
                      <td className="num">
                        {r.cost == null ? <span className="muted">No cost</span> : m(r.cost)}
                        {/* profit is then over the part that has one, so it is not the two columns taken apart */}
                        {r.cost != null && Number(r.costed) !== Number(r.ex_vat) && <small className="cell-sub">Some of these sales have no cost</small>}
                      </td>
                      <td className="num strong">{r.cost == null ? "" : m(Number(r.costed) - Number(r.cost))}</td>
                      <td className="num">{r.cost == null ? "" : pct(margin(Number(r.costed), Number(r.cost)))}</td>
                    </>
                  ) : (
                    <td style={{ width: "22%" }}><span className="bar"><i style={{ width: `${Math.max(0, (Number(r.amount) / top) * 100)}%` }} /></span></td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td /><td>Total</td>{!byCat && <td />}<td className="num">{fmtQty(qty)}</td><td className="num">{m(total)}</td><td className="num">100%</td>{d.costs ? <><td className="num">{m(exVat)}</td><td className="num">{m(cost)}</td><td className="num">{m(costed - cost)}</td><td className="num">{pct(margin(costed, cost))}</td></> : <td />}</tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
