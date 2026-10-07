// stock.test.mjs — a shop's stock in words and figures (web/lib/stock.ts).
// Usage: node web/lib/stock.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { ADJUST_REASONS, adjustProblem, isLow, lineValue, margin, MOVE_LABEL, reorderList, stockStatus, stockTotals, suggestedQty, units, valueBy } from "./stock.ts";

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

// quantities are thousandths: 3 units is 3000
check("a line under zero is below zero, whatever its reorder level", () => {
  assert.equal(stockStatus(-1000, null), "negative");
  assert.equal(stockStatus(-1, 6000), "negative");
});
check("a line at zero is out, also when its reorder level is zero", () => {
  assert.equal(stockStatus(0, null), "out");
  assert.equal(stockStatus(0, 0), "out");
  assert.equal(stockStatus(0, 6000), "out");
});
check("a line at or under its own reorder level is low", () => {
  assert.equal(stockStatus(6000, 6000), "low");
  assert.equal(stockStatus(1, 6000), "low");
  assert.equal(stockStatus(6001, 6000), "ok");
});
check("a line with no reorder level is never low", () => {
  assert.equal(stockStatus(1, null), "ok");
  assert.equal(stockStatus(1000, 0), "ok");
});

check("a line's value is what it holds at its cost, to the cent", () => {
  assert.equal(lineValue(3000, 62000), 186000); // 3 at Rs 620.00
  assert.equal(lineValue(1500, 9567.5), 14351); // 1.5 at Rs 95.675 is Rs 143.5125
  assert.equal(lineValue(-2000, 9500), -19000); // the board's "-Rs 190"
  assert.equal(lineValue(0, 9500), 0);
});
check("the figures on top add the lines up", () => {
  const t = stockTotals([
    { qty: 14000, avgCost: 62000, price: 120000, reorderPoint: 6000 },
    { qty: 3000, avgCost: 62000, price: 120000, reorderPoint: 6000 },
    { qty: 0, avgCost: 18000, price: 35000, reorderPoint: 10000 },
    { qty: -2000, avgCost: 9500, price: 15000, reorderPoint: 12000 },
    { qty: 5000, avgCost: 89000, price: 160000, reorderPoint: null },
  ]);
  assert.deepEqual(t, { atCost: 868000 + 186000 + 0 - 19000 + 445000, atPrice: 1680000 + 360000 + 0 - 30000 + 800000, low: 1, out: 1, negative: 1 });
});
check("no lines, no figures", () => {
  assert.deepEqual(stockTotals([]), { atCost: 0, atPrice: 0, low: 0, out: 0, negative: 0 });
});

check("six reasons for an adjustment: five take out, one puts in", () => {
  assert.deepEqual(ADJUST_REASONS.map(([code, , way]) => code + ":" + way), [
    "damaged:out", "expired:out", "lost:out", "internal:out", "found:in", "supplier_return:out",
  ]);
  assert.equal(ADJUST_REASONS.find(([code]) => code === "internal")[1], "Used in the shop");
});
check("every reason a movement can have has its words", () => {
  for (const r of ["sale", "refund", "adjust", "count", "receive", "supplier_return", "opening", "damaged", "expired", "lost", "internal", "found"]) {
    assert.ok(MOVE_LABEL[r], r);
  }
});

check("a quantity reads as someone would say it", () => {
  assert.equal(units(3000), "3");
  assert.equal(units(1500), "1.5");
  assert.equal(units(-2000), "-2");
  assert.equal(units(1234567), "1,234.567");
});
check("a refusal from the database becomes a sentence the owner can act on", () => {
  assert.match(adjustProblem("not-enough-stock", "3"), /only 3 on hand/);
  assert.match(adjustProblem("pick-variant", "0"), /variant/);
  assert.match(adjustProblem("not-counted", "0"), /not counted/);
  assert.equal(adjustProblem("something else", "0"), null);
});

// ---- the stock reports ----
const shelf = [
  { name: "Shirt", cat: "Clothing", sup: "s1", supName: "Textiles", qty: 12000, avgCost: 62000, price: 99000, reorderPoint: 6000, reorderQty: 24000 },
  { name: "Scarf", cat: "Clothing", sup: "s1", supName: "Textiles", qty: 2500, avgCost: 13333.3333, price: 30000, reorderPoint: 3000, reorderQty: null },
  { name: "Candle", cat: "Home", sup: null, supName: null, qty: -2000, avgCost: 21000, price: 45000, reorderPoint: 0, reorderQty: 0 },
  { name: "Mug", cat: null, sup: "s2", supName: "Atelier", qty: 0, avgCost: 14000, price: 25000, reorderPoint: null, reorderQty: null },
];
check("stock value by category adds up to the totals of Stock on hand, a line below zero included", () => {
  const rows = valueBy(shelf, (l) => l.cat, "No category");
  const all = stockTotals(shelf);
  assert.equal(rows.reduce((a, r) => a + r.atCost, 0), all.atCost);
  assert.equal(rows.reduce((a, r) => a + r.atPrice, 0), all.atPrice);
  assert.deepEqual(rows.map((r) => r.name), ["Clothing", "No category", "Home"]);
  // 12 at Rs 620 and 2.5 at Rs 133.33
  assert.deepEqual(rows[0], { name: "Clothing", lines: 2, units: 14500, atCost: 744000 + 33333, atPrice: 1188000 + 75000 });
  assert.equal(rows[2].atCost, -42000);
});
check("a line is on the reorder list when it has a reorder point and holds that or less", () => {
  assert.equal(isLow(6000, 6000), true);
  assert.equal(isLow(6001, 6000), false);
  assert.equal(isLow(-2000, 0), true);
  // out, but nobody said when to reorder it
  assert.equal(isLow(0, null), false);
});
check("how many to order: what the line says, or what is missing, and one at least", () => {
  assert.equal(suggestedQty(2500, 3000, null), 1000);
  assert.equal(suggestedQty(2500, 3000, 0), 1000);
  assert.equal(suggestedQty(1000, 6000, null), 5000);
  assert.equal(suggestedQty(1000, 6000, 24000), 24000);
  assert.equal(suggestedQty(-2000, 0, 0), 2000);
});
check("the reorder list is by supplier, the lines with no supplier last", () => {
  const list = reorderList(shelf.map((l) => ({ ...l, supplierId: l.sup, supplier: l.supName })));
  assert.deepEqual(list.map((g) => [g.supplier, g.lines.map((l) => l.name + ":" + l.order)]), [
    ["Textiles", ["Scarf:1000"]],
    [null, ["Candle:2000"]],
  ]);
  // one scarf at its average cost, to the cent
  assert.equal(list[0].atCost, 13333);
  assert.equal(list[0].units, 1000);
});
check("margin is profit over sales, and nothing when there are no sales to divide by", () => {
  assert.equal(margin(100000, 62000), 0.38);
  assert.equal(margin(0, 0), null);
  assert.equal(margin(-5000, -3000), null);
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILED` : "all passed");
