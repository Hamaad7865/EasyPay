"use client";

import { useState } from "react";

export type TaxChoice = { id: string; name: string; rate_bp: number; type: string };
// how it is sold (0129): one price each, a price for a kilo, or a price typed at the till
export type Way = "each" | "weight" | "open";

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
// way: how it is sold, chosen under the figures (the price then reads as a
// kilo's, or is typed at the till); atTill: whether a price typed at the till
// may be chosen (not for a product with variants).
export function PriceFields({ cost, price, tax, taxes, showCost, way, atTill }: {
  cost: string; price: string; tax: string; taxes: TaxChoice[]; showCost: boolean; way: Way; atTill: boolean;
}) {
  const [w, setW] = useState<Way>(way);
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
          {w === "weight" ? "Price a kilo (Rs)" : "Selling price (Rs)"}
          <input name="price" value={w === "open" ? "" : p} onChange={(e) => setP(e.target.value)} required={w !== "open"} disabled={w === "open"} placeholder={w === "open" ? "Typed at the till" : undefined} inputMode="decimal" />
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
      {!showCost || w === "open" ? null : margin ? (
        <p className={margin.each < 0 ? "note danger" : "note ok"} style={{ margin: 0 }}>
          <strong>Margin {margin.pct.toFixed(1)}%</strong>: {rs(margin.each)} on {w === "weight" ? "each kilo" : "each one"}{chosen && chosen.rate_bp > 0 && chosen.type === "included" ? ", after the tax" : ""}.
          {margin.each < 0 && " It sells for less than it costs."}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>Type the cost and the selling price to see the margin.</p>
      )}
      <div className="field" role="radiogroup" aria-label="How it is sold" style={{ marginTop: 12, marginBottom: 0 }}>
        How it is sold
        <label className="check">
          <input type="radio" name="sold" value="each" checked={w === "each"} onChange={() => setW("each")} />
          <span>
            Fixed price
            <small>One price for each one sold.</small>
          </span>
        </label>
        <label className="check">
          <input type="radio" name="sold" value="weight" checked={w === "weight"} onChange={() => setW("weight")} />
          <span>
            By the kilo
            <small>The price above is for a kilo: the till asks how heavy and works out the amount. Its stock is counted in kilos.</small>
          </span>
        </label>
        {atTill && (
          <label className="check">
            <input type="radio" name="sold" value="open" checked={w === "open"} onChange={() => setW("open")} />
            <span>
              Price typed at the till
              <small>For a service, or anything charged differently each time: tapping it on the till opens the keypad for its price. It counts no stock.</small>
            </span>
          </label>
        )}
      </div>
    </>
  );
}
