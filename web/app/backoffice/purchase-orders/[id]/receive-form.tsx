"use client";

import { useState } from "react";
import { parseRs } from "@/lib/money";
import { deliveryTotals, lineNote, parseUnits, toCome } from "@/lib/orders";
import { Submit } from "../../busy";

// One line of the order being received. Quantities are thousandths, cost is cents.
export type OrderLine = { key: string; item: string; variant: string | null; label: string; ordered: number; got: number; cost: number };
type Action = (f: FormData) => Promise<void>;

const rupees = (cents: number) => (cents / 100).toFixed(2);
const rs = (cents: number) => "Rs " + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shown = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

// What arrived for an order, after the approved "Receive" board: the day, the
// supplier's invoice number, and for each line how many are arriving now and
// at what cost. It starts on everything that is still to come. `delivery` is
// this delivery's id, made when the page was drawn: pressing Receive twice
// sends the same delivery twice, and the database writes it once.
export function ReceiveForm({ order, delivery, today, lines, action }: { order: string; delivery: string; today: string; lines: OrderLine[]; action: Action }) {
  const rest = () => Object.fromEntries(lines.map((l) => [l.key, toCome(l.ordered, l.got) > 0 ? shown(toCome(l.ordered, l.got)).replace(/,/g, "") : ""]));
  const [qty, setQty] = useState<Record<string, string>>(rest);
  const [cost, setCost] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.key, rupees(l.cost)])));
  const parsed = lines.map((l) => ({ l, qty: parseUnits(qty[l.key] ?? ""), cost: parseRs(cost[l.key] ?? "") }));
  const bad = parsed.some((p) => p.qty === null || ((p.qty ?? 0) > 0 && p.cost === null));
  const arriving = parsed.filter((p) => (p.qty ?? 0) > 0);
  const totals = deliveryTotals(arriving.map((p) => ({ qty: p.qty ?? 0, unitCost: p.cost ?? 0 })));
  const short = parsed.filter((p) => p.l.got + (p.qty ?? 0) < p.l.ordered);

  return (
    <form action={action} className="no-print">
      <input type="hidden" name="id" value={order} />
      <input type="hidden" name="delivery" value={delivery} />
      <input type="hidden" name="lines" value={JSON.stringify(arriving.map((p) => ({ item_id: p.l.item, variant_id: p.l.variant, qty: p.qty, unit_cost: p.cost })))} />
      <input type="hidden" name="lines_ok" value={bad ? "" : "1"} />
      <section className="card">
        <h2>This delivery</h2>
        <div className="grid-3" style={{ gap: "0 20px" }}>
          <label className="field">
            Arrived on
            <input type="date" name="arrived" defaultValue={today} required />
          </label>
          <label className="field">
            Supplier&apos;s invoice number
            <input name="invoice" maxLength={60} autoComplete="off" />
          </label>
          <label className="field">
            Note
            <input name="note" maxLength={200} placeholder="For example, one box was open" />
          </label>
        </div>
      </section>
      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>What arrived</h2>
            <p>Type the quantities. Correct a cost if the invoice differs.</p>
          </div>
          <span className="row-actions">
            <button type="button" className="btn-quiet btn-sm" onClick={() => setQty(rest())}>
              Receive all that was ordered
            </button>
            <button type="button" className="btn-quiet btn-sm" onClick={() => setQty({})}>
              Clear
            </button>
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Ordered</th>
                <th className="num">Received before</th>
                <th className="num">Arriving now</th>
                <th className="num">Unit cost (Rs)</th>
                <th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {parsed.map(({ l, qty: n, cost: c }) => {
                const after = l.got + (n ?? 0);
                const changed = c !== null && c !== l.cost;
                return (
                  <tr key={l.key}>
                    <td>
                      <span className="strong">{l.label}</span>
                      <small className="cell-sub">{changed ? `Cost changed, was ${rs(l.cost)}` : (n ?? 0) > 0 ? lineNote(l.ordered, after) : lineNote(l.ordered, l.got)}</small>
                    </td>
                    <td className="num">{shown(l.ordered)}</td>
                    <td className="num">{shown(l.got)}</td>
                    <td className="num">
                      <input value={qty[l.key] ?? ""} onChange={(e) => setQty((was) => ({ ...was, [l.key]: e.target.value }))} inputMode="decimal" className="narrow" aria-label={`Arriving now, ${l.label}`} aria-invalid={n === null} />
                    </td>
                    <td className="num">
                      <input value={cost[l.key] ?? ""} onChange={(e) => setCost((was) => ({ ...was, [l.key]: e.target.value }))} inputMode="decimal" className="narrow" aria-label={`Unit cost, ${l.label}`} aria-invalid={(n ?? 0) > 0 && c === null} />
                    </td>
                    <td className="num strong">{n !== null && c !== null && n > 0 ? rs(Math.round((n * c) / 1000)) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="strong" colSpan={3}>Units arriving</td>
                <td className="num strong">{shown(totals.units)}</td>
                <td className="num">Delivery total</td>
                <td className="num strong">{rs(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {bad && <p className="note warn" style={{ margin: "12px 20px" }}>A quantity or a cost is not a number. Correct the ones marked.</p>}
        <div className="card-foot">
          <Submit disabled={bad || totals.units === 0}>{totals.units === 0 ? "Receive" : `Receive ${shown(totals.units)} ${totals.units === 1000 ? "unit" : "units"}`}</Submit>
        </div>
      </section>
      <div className="grid-3">
        <div className="note">
          <strong>After this delivery</strong>
          <div>
            {short.length === 0
              ? "The order will have arrived in full."
              : `The order stays open as Part received: ${short.slice(0, 3).map((p) => `${shown(p.l.ordered - p.l.got - (p.qty ?? 0))} ${p.l.label}`).join(", ")}${short.length > 3 ? ` and ${short.length - 3} more lines` : ""} still to come.`}
          </div>
        </div>
        <div className="note">
          <strong>Cost</strong>
          <div>The cost typed here is what the stock comes in at, and becomes the product&apos;s cost. The average cost of what is on the shelf is worked out again.</div>
        </div>
        <div className="note warn">
          <strong>Receiving cannot be undone</strong>
          <div>Goods sent back afterwards go out as Returned to supplier, under Stock on hand.</div>
        </div>
      </div>
    </form>
  );
}
