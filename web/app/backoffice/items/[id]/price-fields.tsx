"use client";

import { useState } from "react";

export type TaxChoice = { id: string; name: string; rate_bp: number; type: string };

// Only for the margin shown while typing: the server reads the amounts for
// good when the product is saved, and refuses what is not a number.
const amount = (s: string) => {
  const v = Number(s.replace(/[\s,]/g, ""));
  return s.trim() !== "" && Number.isFinite(v) ? v : null;
};
const rs = (v: number) => "Rs " + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// What a product costs the shop, what it sells for and the tax it carries,
// with the margin worked out as the figures are typed: what the shop keeps of
// the price once the tax in it and the cost are taken out.
// Someone who may not see cost gets the price and the tax alone.
export function PriceFields({ cost, price, tax, taxes, showCost }: { cost: string; price: string; tax: string; taxes: TaxChoice[]; showCost: boolean }) {
  const [c, setC] = useState(cost);
  const [p, setP] = useState(price);
  const [t, setT] = useState(tax);
  const chosen = taxes.find((x) => x.id === t);
  const costNow = amount(c);
  const priceNow = amount(p);
  const net = priceNow === null ? null : chosen && chosen.type === "included" ? priceNow / (1 + chosen.rate_bp / 10000) : priceNow;
  const margin = net !== null && costNow !== null && net > 0 ? { pct: ((net - costNow) / net) * 100, each: net - costNow } : null;
  return (
    <>
      <div className="grid-3" style={{ gap: "0 20px" }}>
        {showCost && (
          <label className="field">
            Cost (Rs)
            <input name="cost" value={c} onChange={(e) => setC(e.target.value)} inputMode="decimal" placeholder="What you pay for one" />
          </label>
        )}
        <label className="field">
          Selling price (Rs)
          <input name="price" value={p} onChange={(e) => setP(e.target.value)} required inputMode="decimal" />
        </label>
        <label className="field">
          Tax
          <select name="tax" value={t} onChange={(e) => setT(e.target.value)} required>
            {taxes.length === 0 && <option value="">No taxes are set up</option>}
            {taxes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} {x.rate_bp / 100}%{x.rate_bp === 0 ? "" : x.type === "included" ? ", in the price" : ", added on top"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!showCost ? null : margin ? (
        <p className={margin.each < 0 ? "note danger" : "note ok"} style={{ margin: 0 }}>
          <strong>Margin {margin.pct.toFixed(1)}%</strong>: {rs(margin.each)} on each one{chosen && chosen.rate_bp > 0 && chosen.type === "included" ? ", after the tax" : ""}.
          {margin.each < 0 && " It sells for less than it costs."}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>Type the cost and the selling price to see the margin.</p>
      )}
    </>
  );
}
