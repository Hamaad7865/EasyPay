// A purchase order and its deliveries, in words and figures. Pure, so
// `node web/lib/orders.test.mjs` can ask it, and the order pages use it on the
// server and in the browser alike. Quantities are thousandths (3 units is
// 3000), money is cents.

export type OrderStatus = "draft" | "sent" | "part" | "received" | "closed" | "cancelled";
export const ORDER_STATUS: Record<OrderStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  part: "Part received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};
export const ORDER_TONE: Record<OrderStatus, string> = {
  draft: "badge",
  sent: "badge blue",
  part: "badge amber",
  received: "badge green",
  closed: "badge",
  cancelled: "badge red",
};
// an order that is still expected to bring something
export const isOpen = (s: string) => s === "sent" || s === "part";

const shown = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

// What is still to come on a line. More than was ordered may have arrived: then nothing is.
export const toCome = (ordered: number, got: number) => Math.max(0, ordered - got);

// How a line of an order stands.
export function lineNote(ordered: number, got: number): string {
  if (got <= 0) return "Nothing yet";
  if (got > ordered) return `${shown(got - ordered)} more than ordered`;
  if (got === ordered) return "In full";
  return `${shown(ordered - got)} still to come`;
}

// A quantity as typed, in units ("12", "1.5", "1,5"), kept in thousandths.
// Nothing typed is nothing arriving. Null for anything that is not a quantity.
export function parseUnits(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  const m = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(t);
  return m ? Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0")) : null;
}

// The units and the cost of a delivery as it is being typed.
export function deliveryTotals(lines: { qty: number; unitCost: number }[]) {
  let units = 0;
  let total = 0;
  for (const l of lines) {
    units += l.qty;
    total += Math.round((l.qty * l.unitCost) / 1000);
  }
  return { units, total };
}

// What the order functions refuse (migration 0074), as a sentence. Null for anything they did not say.
export function orderProblem(code: string): string | null {
  switch (code) {
    case "not-draft":
      return "This order was already sent, so it can no longer be changed. Reload the page.";
    case "no-lines":
      return "Add at least one product before sending the order.";
    case "not-open":
      return "Only an order that was sent, and has not arrived in full, can be received. Reload the page.";
    case "nothing-received":
      return "Type how many arrived on at least one line.";
    case "already-received":
      return "Something has already arrived for this order, so it cannot be cancelled. Close it instead: what arrived stays in stock.";
    case "not-part":
      return "Only an order that has arrived in part can be closed. Reload the page.";
    case "unknown-supplier":
      return "That supplier is no longer there. Pick another.";
    case "unknown-order":
      return "That order is no longer there.";
    case "bad-line":
      return "Every line needs a quantity above zero and a cost of zero or more.";
    case "pick-variant":
      return "One of the products has variants: order its variants, not the product.";
    case "unknown-line":
      return "One of the variants is no longer there. Remove its line and add it again.";
    case "unknown-item":
      return "One of the products is no longer there. Remove its line.";
    case "not-counted":
      return "One of the products is not counted in stock. Tick Counted in stock on its page first.";
    default:
      return null;
  }
}
