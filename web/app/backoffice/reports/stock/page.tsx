import Link from "next/link";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { filters, reportStart, today } from "@/lib/report";
import { COUNTED_SQL, LOSSES_SQL, UNSOLD_SQL } from "@/lib/stock-reports";
import { one, PageHead, type Search } from "../../ui";
import { Go, Submit, Wait } from "../../busy";
import { ReportFilters } from "../parts";
import { CsvButton, PrintButton } from "../print-button";
import { type Counted, type Line, type Loss, Losses, type Quiet, Reorder, Unsold, Value } from "./views";

const PATH = "/backoffice/reports/stock";
const VIEWS = [
  ["value", "Stock value", "What the stock is worth, by category and by supplier."],
  ["reorder", "Reorder list", "What is at or under its reorder point, by supplier, with how many to order."],
  ["losses", "Losses", "What was taken out of stock as damaged, expired or lost."],
  ["unsold", "Not selling", "What holds stock and has not sold for a while."],
] as const;
type View = (typeof VIEWS)[number][0];
const DAYS = [30, 60, 90, 180];

type OnHand = {
  item_id: string; variant_id: string | null; name: string; variant: string | null; category: string | null; supplier_id: string | null; supplier: string | null;
  price: string; qty: number; avg_cost: string; reorder_point: number | null; reorder_qty: number | null; sold30: number;
};

// A shop's stock reports, four views of one page (the first shop: stock is
// kept per shop and one shop is shown). Seeing them takes "See reports" and
// "See stock"; every figure in rupees also takes "See cost and profit".
export default async function StockReports({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const asked = one(sp.view);
  const view: View = VIEWS.some(([v]) => v === asked) ? (asked as View) : "value";
  const days = DAYS.includes(Number(one(sp.days))) ? Number(one(sp.days)) : 60;
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const may = (await c.query(`select has_perm($1, 'stock.view') as stock, has_perm($1, 'costs.view') as costs, first_store($2) as store`, [ctx.employeeId, ctx.tenantId])).rows[0] as {
      stock: boolean; costs: boolean; store: string | null;
    };
    // losses open on this month so far, not on today alone
    const f = filters({ ...sp, from: one(sp.from) || today(l.tz).slice(0, 8) + "01" }, l.tz);
    const base = { l, f, s, costs: Boolean(may.costs) };
    if (!ok || !may.stock || !may.store) return { ...base, ok: false as const };
    // what the view picked asks, and nothing else
    const got: { losses?: Loss[]; counted?: Counted; quiet?: Quiet[]; lines?: Line[] } = {};
    if (view === "losses") {
      const [rows, counted] = await Promise.all([c.query(LOSSES_SQL, [ctx.tenantId, may.store, f.from, f.to]), c.query(COUNTED_SQL, [ctx.tenantId, may.store, f.from, f.to])]);
      got.losses = rows.rows as Loss[];
      got.counted = counted.rows[0] as Counted;
    } else if (view === "unsold") {
      got.quiet = (await c.query(UNSOLD_SQL, [ctx.tenantId, may.store, days])).rows as Quiet[];
    } else if (view === "reorder" || may.costs) {
      // (stock value is nothing but rupees: without the right to see them there is nothing to ask)
      const rows = (await c.query(`select * from stock_on_hand($1, $2)`, [ctx.tenantId, may.store])).rows as OnHand[];
      got.lines = rows.map((r) => ({
        item_id: r.item_id, variant_id: r.variant_id, name: r.name, variant: r.variant, category: r.category, supplierId: r.supplier_id, supplier: r.supplier,
        qty: r.qty, avgCost: Number(r.avg_cost), price: Number(r.price), reorderPoint: r.reorder_point, reorderQty: r.reorder_qty, sold30: r.sold30,
      }));
    }
    return { ...base, ok: true as const, ...got };
  });
  const [, title, lede] = VIEWS.find(([v]) => v === view)!;
  const head = (
    <PageHead title={title} lede={lede}>
      {d.ok && view !== "losses" && !(view === "value" && !d.costs) && (
        <>
          <CsvButton />
          <PrintButton />
        </>
      )}
    </PageHead>
  );
  const tabs = (
    <div className="tabs no-print">
      {VIEWS.map(([v, name]) => (
        <Link key={v} href={`${PATH}?view=${v}`} className={v === view ? "on" : undefined}>
          {name}
          <Wait />
        </Link>
      ))}
    </div>
  );
  if (!d.ok) {
    return (
      <div>
        {head}
        <div className="note warn">Your role does not include seeing stock reports: they take both See reports and See stock, under Roles and permissions.</div>
      </div>
    );
  }
  const rs = d.costs ? (cents: number) => money(Math.round(cents), d.s.decimals) : null;
  return (
    <div>
      {head}
      {tabs}
      {view === "value" &&
        (rs ? <Value lines={d.lines ?? []} rs={rs} /> : <div className="note warn">Stock value is a figure in rupees, at cost. Your role does not include seeing cost and profit.</div>)}
      {view === "reorder" && <Reorder lines={d.lines ?? []} rs={rs} />}
      {view === "losses" && (
        <>
          <ReportFilters path={PATH} f={d.f} l={d.l} show={[]}>
            <input type="hidden" name="view" value="losses" />
          </ReportFilters>
          <Losses rows={d.losses ?? []} counted={d.counted ?? { qty: 0, counts: 0, value: "0" }} rs={rs} />
        </>
      )}
      {view === "unsold" && (
        <>
          <Go className="filters no-print" action={PATH}>
            <input type="hidden" name="view" value="unsold" />
            <label>
              Not sold in the last
              <select name="days" defaultValue={String(days)}>
                {DAYS.map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
              </select>
            </label>
            <Submit>Show</Submit>
          </Go>
          <Unsold rows={d.quiet ?? []} days={days} rs={rs} />
        </>
      )}
    </div>
  );
}
