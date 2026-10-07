// A shop's stock, in words and figures: what the Stock pages say about a
// line, and the sums on top of them. Pure, so `node web/lib/stock.test.mjs`
// can ask it. Quantities are thousandths (3 units is 3000), money is cents;
// an average cost is cents with decimals, as the database keeps it.

export type StockStatus = "negative" | "out" | "low" | "ok";
export const STATUS_LABEL: Record<StockStatus, string> = { negative: "Below zero", out: "Out", low: "Low", ok: "In stock" };

// Below zero comes first (a delivery was not entered, or a count is wrong),
// then out. Low is at or under the line's own reorder level: a line that was
// given none is never low.
export function stockStatus(qty: number, reorderPoint: number | null): StockStatus {
  if (qty < 0) return "negative";
  if (qty === 0) return "out";
  if (reorderPoint !== null && qty <= reorderPoint) return "low";
  return "ok";
}

// What a quantity is worth at a price per unit, to the cent.
export const lineValue = (qty: number, perUnit: number) => Math.round((qty * perUnit) / 1000);

export type StockLine = { qty: number; avgCost: number; price: number; reorderPoint: number | null };

// The figures above the list. A line below zero counts for what it shows, so
// the totals are the sums of the columns under them.
export function stockTotals(lines: StockLine[]) {
  const t = { atCost: 0, atPrice: 0, low: 0, out: 0, negative: 0 };
  for (const l of lines) {
    t.atCost += lineValue(l.qty, l.avgCost);
    t.atPrice += lineValue(l.qty, l.price);
    const s = stockStatus(l.qty, l.reorderPoint);
    if (s !== "ok") t[s] += 1;
  }
  return t;
}

// The reasons stock is adjusted by hand, in the order the form offers them.
// The reason decides the direction: stock is added, with its cost, by
// receiving a delivery.
export const ADJUST_REASONS = [
  ["damaged", "Damaged", "out"],
  ["expired", "Expired", "out"],
  ["lost", "Lost or stolen", "out"],
  ["internal", "Used in the shop", "out"],
  ["found", "Found", "in"],
  ["supplier_return", "Returned to supplier", "out"],
] as const;

// Every reason a movement can have (stock_movements.reason), as the Movements page says it.
export const MOVE_LABEL: Record<string, string> = {
  sale: "Sold",
  refund: "Returned by a customer",
  receive: "Received",
  supplier_return: "Returned to supplier",
  count: "Counted",
  opening: "Opening stock",
  damaged: "Damaged",
  expired: "Expired",
  lost: "Lost or stolen",
  internal: "Used in the shop",
  found: "Found",
  adjust: "Adjusted",
};

export const units = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

// What stock_adjust refused, as a sentence. Null for anything it did not say.
export function adjustProblem(code: string, onHand: string): string | null {
  switch (code) {
    case "not-enough-stock":
      return `There are only ${onHand} on hand, so that many cannot be taken out. Check the quantity, or count the line if the figure is wrong.`;
    case "pick-variant":
      return "This product has variants: adjust the variant, not the product.";
    case "unknown-line":
      return "That variant is no longer there. Reload the page.";
    case "unknown-item":
      return "That product is no longer there. Reload the page.";
    case "not-counted":
      return "This product is not counted in stock. Tick Counted in stock on its page first.";
    case "bad-quantity":
      return "Type how many, as a number above zero.";
    case "bad-reason":
      return "Pick the reason.";
    default:
      return null;
  }
}
