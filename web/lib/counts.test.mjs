// counts.test.mjs — a stock count in words and figures (web/lib/counts.ts).
// Usage: node web/lib/counts.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { COUNT_STATUS, countProblem, LINE_STATE, reviewTotals } from "./counts.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + e.message);
  }
}
// a line of the review: quantities in thousandths, value in cents
const line = (state, diff, value, leftOut = false) => ({ state, diff, value, left_out: leftOut });

check("the states of a count and of its lines have their words", () => {
  assert.deepEqual(COUNT_STATUS, { open: "Counting", completed: "Completed", cancelled: "Cancelled" });
  assert.deepEqual(LINE_STATE, { different: "Different", matching: "Matching", uncounted: "Not counted" });
});

check("the review adds up what differs, in units and at cost", () => {
  const t = reviewTotals([
    line("different", 1000, 62000), line("different", -1000, -62000), line("different", -1000, -89000), line("different", -3000, -84000), line("different", 1000, 145000),
    line("matching", 0, 0), line("matching", 0, 0), line("uncounted", null, null),
  ]);
  assert.deepEqual(t, { different: 5, matching: 2, uncounted: 1, leftOut: 0, counted: 7, lines: 8, units: -3000, value: -28000 });
});
check("a line left out counts for nothing in the sums, and is said to be left out", () => {
  const t = reviewTotals([line("different", -2000, -5000), line("different", 5000, 9000, true), line("uncounted", null, null, true), line("matching", 0, 0)]);
  assert.deepEqual(t, { different: 1, matching: 1, uncounted: 0, leftOut: 2, counted: 2, lines: 4, units: -2000, value: -5000 });
});
check("an empty count adds up to nothing", () => {
  assert.deepEqual(reviewTotals([]), { different: 0, matching: 0, uncounted: 0, leftOut: 0, counted: 0, lines: 0, units: 0, value: 0 });
});

check("what the database refuses becomes a sentence the owner can act on", () => {
  for (const code of ["count-closed", "nothing-to-count", "bad-scope", "not-counted", "pick-variant", "unknown-item", "unknown-line", "bad-quantity", "unknown-count", "bad-uncounted"]) {
    assert.ok(countProblem(code), code);
  }
  assert.match(countProblem("count-closed"), /completed|cancelled/);
  assert.equal(countProblem("something else"), null);
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILED` : "all passed");
