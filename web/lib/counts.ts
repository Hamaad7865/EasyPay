// A stock count, in words and figures. Pure, so `node web/lib/counts.test.mjs`
// can ask it. Quantities are thousandths, values are cents.

export type CountStatus = "open" | "completed" | "cancelled";
export const COUNT_STATUS: Record<CountStatus, string> = { open: "Counting", completed: "Completed", cancelled: "Cancelled" };
export const COUNT_TONE: Record<CountStatus, string> = { open: "badge blue", completed: "badge green", cancelled: "badge" };

export type LineState = "different" | "matching" | "uncounted";
export const LINE_STATE: Record<LineState, string> = { different: "Different", matching: "Matching", uncounted: "Not counted" };

export type ReviewLine = { state: LineState; diff: number | null; value: number | null; left_out: boolean };

// The figures of the review. A line left out of the count is in none of the
// sums: completing the count will not touch it.
export function reviewTotals(lines: ReviewLine[]) {
  const t = { different: 0, matching: 0, uncounted: 0, leftOut: 0, counted: 0, lines: lines.length, units: 0, value: 0 };
  for (const l of lines) {
    if (l.left_out) {
      t.leftOut += 1;
      continue;
    }
    t[l.state] += 1;
    if (l.state !== "uncounted") t.counted += 1;
    t.units += l.diff ?? 0;
    t.value += l.value ?? 0;
  }
  return t;
}

// What the count functions refuse (migration 0075), as a sentence. Null for anything they did not say.
export function countProblem(code: string): string | null {
  switch (code) {
    case "count-closed":
      return "This count was already completed or cancelled, so nothing more can be counted on it. Reload the page.";
    case "nothing-to-count":
      return "Nothing counted in stock fits that: there would be no lines to count.";
    case "bad-scope":
      return "Pick what to count: the whole shop, a category, a supplier or a brand.";
    case "not-counted":
      return "That product is not counted in stock. Tick Counted in stock on its page first.";
    case "pick-variant":
      return "That product has variants: count the variant, not the product.";
    case "unknown-item":
      return "No product has that code.";
    case "unknown-line":
      return "That line is no longer there. Reload the page.";
    case "bad-quantity":
      return "Type how many, as a number of zero or more.";
    case "unknown-count":
      return "That count is no longer there.";
    case "bad-uncounted":
      return "Say what to do with the lines that were not counted.";
    default:
      return null;
  }
}
