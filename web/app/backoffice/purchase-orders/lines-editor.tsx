"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { parseRs } from "@/lib/money";
import { deliveryTotals, parseUnits } from "@/lib/orders";
import { fold } from "../table-kit";

// A line of stock that can be put on an order or a delivery: a counted
// product, or one variant of it. `cost` is cents.
export type LineOption = { key: string; item: string; variant: string | null; label: string; sku: string | null; barcode: string | null; cost: number; mine: boolean };
// A line as it is being typed: the quantity in units, the cost in rupees.
export type TypedLine = { key: string; item: string; variant: string | null; label: string; qty: string; cost: string };

const rupees = (cents: number) => (cents / 100).toFixed(2);
const rs = (cents: number) => "Rs " + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shown = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

// The lines of a draft order, or of a delivery nobody ordered. A product is
// found by its name, its SKU or a scanned barcode (a scan adds one; scanning
// it again adds one more). What is typed travels with the form as one field,
// `lines`, in thousandths and cents; `lines_ok` is empty while a quantity or
// a cost is not a number, and the server refuses the save then.
export function LinesEditor({ options, start, what }: { options: LineOption[]; start: TypedLine[]; what: "order" | "delivery" }) {
  const [lines, setLines] = useState<TypedLine[]>(start);
  const [q, setQ] = useState("");
  const hay = useMemo(() => options.map((o) => ({ o, text: fold([o.label, o.sku ?? "", o.barcode ?? ""].join(" ")) })), [options]);
  const on = new Set(lines.map((l) => l.key));
  const words = fold(q).split(/\s+/).filter(Boolean);
  const code = q.trim().toLowerCase();
  const exact = code ? options.find((o) => (o.barcode ?? "").toLowerCase() === code || (o.sku ?? "").toLowerCase() === code) : undefined;
  const found = words.length === 0 ? [] : hay.filter((h) => words.every((w) => h.text.includes(w))).map((h) => h.o);
  // the supplier's own products first, then the rest; what is on the list already is left out
  const offered = found.filter((o) => !on.has(o.key)).sort((a, b) => Number(b.mine) - Number(a.mine) || a.label.localeCompare(b.label)).slice(0, 8);

  const add = (o: LineOption) => {
    setLines((was) =>
      was.some((l) => l.key === o.key)
        ? was.map((l) => (l.key === o.key ? { ...l, qty: shown((parseUnits(l.qty) ?? 0) + 1000) } : l))
        : [...was, { key: o.key, item: o.item, variant: o.variant, label: o.label, qty: "1", cost: rupees(o.cost) }],
    );
    setQ("");
  };
  const change = (key: string, field: "qty" | "cost", value: string) => setLines((was) => was.map((l) => (l.key === key ? { ...l, [field]: value } : l)));

  const parsed = lines.map((l) => ({ l, qty: parseUnits(l.qty), cost: parseRs(l.cost) }));
  const bad = parsed.some((p) => p.qty === null || p.qty === 0 || p.cost === null);
  const totals = deliveryTotals(parsed.map((p) => ({ qty: p.qty ?? 0, unitCost: p.cost ?? 0 })));

  return (
    <div>
      <input type="hidden" name="lines" value={JSON.stringify(parsed.map((p) => ({ item_id: p.l.item, variant_id: p.l.variant, qty: p.qty, unit_cost: p.cost })))} />
      <input type="hidden" name="lines_ok" value={bad ? "" : "1"} />
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <label className="field" style={{ marginBottom: 8 }}>
          Add a product
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Enter is the scanner's last key: it adds the product and never sends the form
              e.preventDefault();
              const pick = exact ?? (offered.length === 1 ? offered[0] : undefined);
              if (pick) add(pick);
            }}
            placeholder="Name, SKU or scan a barcode"
            autoComplete="off"
          />
        </label>
        {words.length > 0 && (
          <div className="bo-toolbar" style={{ marginBottom: 12 }}>
            {offered.map((o) => (
              <button key={o.key} type="button" className="btn-quiet btn-sm" onClick={() => add(o)}>
                {o.label}
              </button>
            ))}
            {offered.length === 0 && <span className="muted">{exact && on.has(exact.key) ? "Already on the list: Enter adds one more." : "Nothing counted in stock is called that."}</span>}
          </div>
        )}
      </div>
      {lines.length === 0 ? (
        <div className="card-body muted">No products yet. Find the first one above{what === "order" ? ", or add what is low." : "."}</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">{what === "order" ? "Quantity" : "Arrived"}</th>
                <th className="num">Unit cost (Rs)</th>
                <th className="num">Line total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {parsed.map(({ l, qty, cost }) => (
                <tr key={l.key}>
                  <td className="strong">{l.label}</td>
                  <td className="num">
                    <input value={l.qty} onChange={(e) => change(l.key, "qty", e.target.value)} inputMode="decimal" className="narrow" aria-label={`Quantity of ${l.label}`} aria-invalid={qty === null || qty === 0} />
                  </td>
                  <td className="num">
                    <input value={l.cost} onChange={(e) => change(l.key, "cost", e.target.value)} inputMode="decimal" className="narrow" aria-label={`Unit cost of ${l.label}`} aria-invalid={cost === null} />
                  </td>
                  <td className="num">{qty !== null && cost !== null ? rs(Math.round((qty * cost) / 1000)) : <span className="muted">Not a number</span>}</td>
                  <td>
                    <button type="button" className="btn-link danger" onClick={() => setLines((was) => was.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.label}`}>
                      <X aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="strong">{lines.length === 1 ? "1 product" : `${lines.length} products`}</td>
                <td className="num strong">{shown(totals.units)}</td>
                <td />
                <td className="num strong">{rs(totals.total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {bad && <p className="note warn" style={{ margin: "12px 20px" }}>Every line needs a quantity above zero and a cost. Correct the ones marked, or remove them.</p>}
    </div>
  );
}
