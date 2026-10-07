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

// ---- the stock reports ----

// Stock value split by one of its names (a category, a supplier): how many
// lines, how many units, and what they are worth at cost and at shelf price.
// The same sum per line as stockTotals, so the rows add up to its totals.
export function valueBy<T extends StockLine>(lines: T[], key: (l: T) => string | null, none: string) {
  const rows = new Map<string, { name: string; lines: number; units: number; atCost: number; atPrice: number }>();
  for (const l of lines) {
    const name = key(l) ?? none;
    const r = rows.get(name) ?? { name, lines: 0, units: 0, atCost: 0, atPrice: 0 };
    r.lines += 1;
    r.units += l.qty;
    r.atCost += lineValue(l.qty, l.avgCost);
    r.atPrice += lineValue(l.qty, l.price);
    rows.set(name, r);
  }
  return [...rows.values()].sort((a, b) => b.atCost - a.atCost || a.name.localeCompare(b.name));
}

// On the reorder list: the line was given a reorder point and holds that or
// less. The rule "Add what is low" uses on a purchase order (po_fill_low).
export const isLow = (qty: number, reorderPoint: number | null) => reorderPoint !== null && qty <= reorderPoint;

// How many to order, as po_fill_low works it out: what the line says to
// order, or else what is missing to its reorder point, and one at least.
export const suggestedQty = (qty: number, reorderPoint: number, reorderQty: number | null) =>
  reorderQty !== null && reorderQty !== 0 ? reorderQty : Math.max(reorderPoint - qty, 1000);

export type ReorderLine = StockLine & { name: string; supplierId: string | null; supplier: string | null; reorderQty: number | null };

// The low lines, by supplier (those with no supplier last), each with how
// many to order and what the order would cost at the line's average cost.
export function reorderList<T extends ReorderLine>(lines: T[]) {
  const groups = new Map<string, { supplierId: string | null; supplier: string | null; lines: (T & { order: number })[]; units: number; atCost: number }>();
  for (const l of lines) {
    if (l.reorderPoint === null || !isLow(l.qty, l.reorderPoint)) continue;
    const order = suggestedQty(l.qty, l.reorderPoint, l.reorderQty);
    const g = groups.get(l.supplierId ?? "") ?? { supplierId: l.supplierId, supplier: l.supplier, lines: [], units: 0, atCost: 0 };
    g.lines.push({ ...l, order });
    g.units += order;
    g.atCost += lineValue(order, l.avgCost);
    groups.set(l.supplierId ?? "", g);
  }
  for (const g of groups.values()) g.lines.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups.values()].sort((a, b) => (a.supplier === null ? 1 : 0) - (b.supplier === null ? 1 : 0) || (a.supplier ?? "").localeCompare(b.supplier ?? ""));
}

// Profit as a share of sales (both without VAT). Null when there are no sales to divide by.
export const margin = (sales: number, cost: number): number | null => (sales > 0 ? (sales - cost) / sales : null);

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
