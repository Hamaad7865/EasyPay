import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { isLow, lineValue, MOVE_LABEL, type ReorderLine, reorderList, stockTotals, units, valueBy } from "@/lib/stock";
import { Card, Empty } from "../../ui";
import { Stat } from "../parts";

// The four views of Stock reports. Each is given its rows and draws them:
// what it asks is in web/lib/stock-reports.ts and web/lib/stock.ts, where a
// suite asks the same. `rs` writes cents as money; a view is only handed it
// when this person may see cost and profit.

type Rs = (cents: number) => string;

// One line of a shop's stock, as stock_on_hand gives it, with its figures as numbers.
export type Line = ReorderLine & { item_id: string; variant_id: string | null; variant: string | null; category: string | null; sold30: number };
const label = (l: { name: string; variant: string | null }) => l.name + (l.variant ? ", " + l.variant : "");
const share = (part: number, whole: number) => (whole > 0 ? ((part / whole) * 100).toFixed(1) + "%" : "");

// What the stock is worth, and where it sits. A figure in rupees throughout.
export function Value({ lines, rs }: { lines: Line[]; rs: Rs }) {
  if (lines.length === 0) return <Empty icon={PackageCheck} title="Nothing is counted in stock yet">A product is counted once Counted in stock is ticked on its page.</Empty>;
  const all = stockTotals(lines);
  const table = (title: string, rows: ReturnType<typeof valueBy>, what: string) => (
    <Card title={title} flush>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{what}</th>
              <th className="num">Lines</th>
              <th className="num">Units</th>
              <th className="num">At cost</th>
              <th className="num">Share</th>
              <th className="num">At shelf price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="strong">{r.name}</td>
                <td className="num">{r.lines}</td>
                <td className="num">{units(r.units)}</td>
                <td className="num strong">{rs(r.atCost)}</td>
                <td className="num">{share(r.atCost, all.atCost)}</td>
                <td className="num">{rs(r.atPrice)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num">{lines.length}</td>
              <td className="num">{units(lines.reduce((a, l) => a + l.qty, 0))}</td>
              <td className="num">{rs(all.atCost)}</td>
              <td className="num">{all.atCost > 0 ? "100%" : ""}</td>
              <td className="num">{rs(all.atPrice)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
  return (
    <>
      <div className="stats">
        <Stat label="Stock at cost" value={rs(all.atCost)} note="What it cost to buy, at each line's average cost" />
        <Stat label="At shelf price" value={rs(all.atPrice)} note="What it would sell for, VAT as the prices have it" />
        <Stat label="Lines of stock" value={String(lines.length)} />
        {all.negative > 0 && <Stat label="Lines below zero" value={String(all.negative)} note="They count for what they show: a delivery was not entered, or a count is wrong" />}
      </div>
      {table("By category", valueBy(lines, (l) => l.category, "No category"), "Category")}
      {table("By supplier", valueBy(lines, (l) => l.supplier, "No supplier"), "Supplier")}
    </>
  );
}

// What to order, by supplier: the rule and the quantities of "Add what is low" on a purchase order.
export function Reorder({ lines, rs }: { lines: Line[]; rs: Rs | null }) {
  const groups = reorderList(lines);
  // out, and nobody said when to reorder it: not on the list, so said beside it
  const loose = lines.filter((l) => l.qty <= 0 && l.reorderPoint === null).length;
  const hint = loose > 0 && (
    <p className="muted">
      {loose} {loose === 1 ? "line is" : "lines are"} out of stock with no reorder point, so {loose === 1 ? "it is" : "they are"} not on this list. Set a reorder point on a product's page to have it listed.
    </p>
  );
  if (groups.length === 0) {
    return (
      <>
        <Empty icon={PackageCheck} title="Nothing to reorder">No line is at or under its reorder point.</Empty>
        {hint}
      </>
    );
  }
  const n = groups.reduce((a, g) => a + g.lines.length, 0);
  return (
    <>
      <div className="stats">
        <Stat label="Lines to reorder" value={String(n)} note="At or under their reorder point" />
        <Stat label="Suppliers" value={String(groups.filter((g) => g.supplier !== null).length)} />
        <Stat label="Units to order" value={units(groups.reduce((a, g) => a + g.units, 0))} />
        {rs && <Stat label="What the orders would cost" value={rs(groups.reduce((a, g) => a + g.atCost, 0))} note="At each line's average cost" />}
      </div>
      {hint}
      {groups.map((g) => (
        <Card
          key={g.supplierId ?? "none"}
          title={g.supplier ?? "No supplier"}
          lede={g.supplier === null ? "Give these products a supplier to order them with the rest." : "A new order for this supplier, then Add what is low, puts these lines on it."}
          action={g.supplier === null ? undefined : <Link href="/backoffice/purchase-orders" className="card-link no-print">Purchase orders</Link>}
          flush
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">On hand</th>
                  <th className="num">Reorder point</th>
                  <th className="num">Sold in 30 days</th>
                  <th className="num">To order</th>
                  {rs && <th className="num">Cost</th>}
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l) => (
                  <tr key={l.item_id + (l.variant_id ?? "")}>
                    <td className="strong">{label(l)}</td>
                    <td className="num" style={l.qty <= 0 ? { color: "var(--red)" } : undefined}>{units(l.qty)}</td>
                    <td className="num">{units(l.reorderPoint ?? 0)}</td>
                    <td className="num">{units(l.sold30)}</td>
                    <td className="num strong">{units(l.order)}</td>
                    {rs && <td className="num">{rs(lineValue(l.order, l.avgCost))}</td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td />
                  <td />
                  <td className="num">{units(g.units)}</td>
                  {rs && <td className="num">{rs(g.atCost)}</td>}
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}

export type Loss = { reason: string; name: string; variant: string | null; category: string | null; qty: number; times: number; value: string | null };
export type Counted = { qty: number; counts: number; value: string };

// What was damaged, expired or lost in the days asked.
export function Losses({ rows, counted, rs }: { rows: Loss[]; counted: Counted; rs: Rs | null }) {
  const signed = (q: number) => (q > 0 ? "+" : "") + units(q);
  const counts = counted.counts > 0 && (
    <p className="muted">
      In the same days, {counted.counts === 1 ? "one stock count" : `${counted.counts} stock counts`} corrected stock by {signed(counted.qty)} {Math.abs(counted.qty) === 1000 ? "unit" : "units"} in all
      {rs ? ` (${rs(Number(counted.value))} at cost)` : ""}. That is not in the figures above: a count finds goods as well as missing ones. See Counts.
    </p>
  );
  if (rows.length === 0) {
    return (
      <>
        <Empty icon={PackageCheck} title="Nothing was written off in these days">Stock taken out as damaged, expired or lost shows here. Pick other dates to look further back.</Empty>
        {counts}
      </>
    );
  }
  const by = ["damaged", "expired", "lost"].map((reason) => {
    const of = rows.filter((r) => r.reason === reason);
    return { reason, products: of.length, qty: of.reduce((a, r) => a + r.qty, 0), value: of.reduce((a, r) => a + Number(r.value ?? 0), 0) };
  });
  const qty = by.reduce((a, r) => a + r.qty, 0), value = by.reduce((a, r) => a + r.value, 0);
  const noCost = rows.some((r) => r.value === null);
  return (
    <>
      <div className="stats">
        <Stat label="Units written off" value={units(qty)} />
        {rs && <Stat label="What they cost" value={rs(value)} note="At the cost each had on the day" />}
        {by.map((r) => (
          <Stat key={r.reason} label={MOVE_LABEL[r.reason]} value={units(r.qty)} note={rs ? rs(r.value) : undefined} />
        ))}
      </div>
      {rs && noCost && <p className="muted">A line with no figure in rupees had no cost on file when it was written off: it is in the units and in no amount.</p>}
      <Card title="By product" flush>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th>Product</th>
                <th>Category</th>
                <th className="num">Times</th>
                <th className="num">Units</th>
                {rs && <th className="num">At cost</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{MOVE_LABEL[r.reason] ?? r.reason}</td>
                  <td className="strong">{label(r)}</td>
                  <td>{r.category ?? <span className="muted">None</span>}</td>
                  <td className="num">{r.times}</td>
                  <td className="num">{units(r.qty)}</td>
                  {rs && <td className="num strong">{r.value === null ? "" : rs(Number(r.value))}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td />
                <td />
                <td className="num">{rows.reduce((a, r) => a + r.times, 0)}</td>
                <td className="num">{units(qty)}</td>
                {rs && <td className="num">{rs(value)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      {counts}
    </>
  );
}

export type Quiet = {
  item_id: string; variant_id: string | null; name: string; variant: string | null; category: string | null; supplier: string | null;
  qty: number; avg_cost: string; price: string; last_sold: string | null; days_quiet: number | null; last_in: string | null; days_in: number | null;
};

// What holds stock and has not sold in the days asked.
export function Unsold({ rows, days, rs }: { rows: Quiet[]; days: number; rs: Rs | null }) {
  if (rows.length === 0) return <Empty icon={PackageCheck} title={`Everything in stock sold in the last ${days} days`}>A line that holds stock and has no sale in that time shows here.</Empty>;
  const cost = (r: Quiet) => lineValue(r.qty, Number(r.avg_cost));
  // came in after the days asked began: it has not had that long to sell
  const fresh = rows.filter((r) => r.days_in !== null && r.days_in < days).length;
  return (
    <>
      <div className="stats">
        <Stat label="Lines not selling" value={String(rows.length)} note={`No sale in the last ${days} days`} />
        <Stat label="Units" value={units(rows.reduce((a, r) => a + r.qty, 0))} />
        {rs && <Stat label="Money sitting in them" value={rs(rows.reduce((a, r) => a + cost(r), 0))} note="At cost" />}
        <Stat label="Never sold" value={String(rows.filter((r) => r.last_sold === null).length)} />
      </div>
      {fresh > 0 && (
        <p className="muted">
          {fresh} of these lines had stock come in during the last {days} days: {fresh === 1 ? "it has" : "they have"} not had that long to sell.
        </p>
      )}
      <Card flush>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Supplier</th>
                <th className="num">On hand</th>
                <th>Last sold</th>
                <th>Stock last came in</th>
                {rs && <th className="num">At cost</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item_id + (r.variant_id ?? "")}>
                  <td className="strong">{label(r)}</td>
                  <td>{r.category ?? <span className="muted">None</span>}</td>
                  <td>{r.supplier ?? <span className="muted">None</span>}</td>
                  <td className="num">{units(r.qty)}</td>
                  <td>
                    {r.last_sold ?? <span className="muted">Never</span>}
                    {r.days_quiet !== null && <small className="cell-sub">{r.days_quiet} days ago</small>}
                  </td>
                  <td>
                    {r.last_in ?? <span className="muted">Not known</span>}
                    {r.days_in !== null && r.days_in < days && <small className="cell-sub">{r.days_in === 0 ? "Today" : r.days_in === 1 ? "Yesterday" : `${r.days_in} days ago`}</small>}
                  </td>
                  {rs && <td className="num strong">{rs(cost(r))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// How many lines are on the reorder list, for the tab's own figure.
export const lowCount = (lines: Line[]) => lines.filter((l) => isLow(l.qty, l.reorderPoint)).length;
