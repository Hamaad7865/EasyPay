// orders.test.mjs — a purchase order and its deliveries in words and figures (web/lib/orders.ts).
// Usage: node web/lib/orders.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { deliveryTotals, lineNote, ORDER_STATUS, orderProblem, parseUnits, toCome } from "./orders.ts";

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

check("every state an order can be in has its words", () => {
  assert.deepEqual(ORDER_STATUS, { draft: "Draft", sent: "Sent", part: "Part received", received: "Received", closed: "Closed", cancelled: "Cancelled" });
});

// quantities are thousandths: 3 units is 3000
check("what is still to come on a line is never less than nothing", () => {
  assert.equal(toCome(40000, 30000), 10000);
  assert.equal(toCome(12000, 12000), 0);
  assert.equal(toCome(6000, 9000), 0);
  assert.equal(toCome(6000, 0), 6000);
});
check("how a line of an order stands, in words", () => {
  assert.equal(lineNote(12000, 0), "Nothing yet");
  assert.equal(lineNote(40000, 30000), "10 still to come");
  assert.equal(lineNote(12000, 12000), "In full");
  assert.equal(lineNote(6000, 9000), "3 more than ordered");
  assert.equal(lineNote(1500, 500), "1 still to come");
});

check("a quantity typed in units is kept in thousandths", () => {
  assert.equal(parseUnits("12"), 12000);
  assert.equal(parseUnits(" 1.5 "), 1500);
  assert.equal(parseUnits("1,5"), 1500);
  assert.equal(parseUnits("0.125"), 125);
  assert.equal(parseUnits("0"), 0);
  assert.equal(parseUnits(""), 0);
});
check("anything that is not a quantity is not read as one", () => {
  for (const t of ["abc", "-1", "1.2345", "1e3", "12 3", "1.2.3", "99999999"]) assert.equal(parseUnits(t), null, t);
});

check("the units and the total of a delivery being typed", () => {
  // 12 at Rs 620.00, 30 at Rs 180.00, and a line of nothing
  assert.deepEqual(deliveryTotals([{ qty: 12000, unitCost: 62000 }, { qty: 30000, unitCost: 18000 }, { qty: 0, unitCost: 21000 }]), { units: 42000, total: 744000 + 540000 });
  assert.deepEqual(deliveryTotals([{ qty: 1500, unitCost: 9567 }]), { units: 1500, total: 14351 });
  assert.deepEqual(deliveryTotals([]), { units: 0, total: 0 });
});

check("what the database refuses becomes a sentence the owner can act on", () => {
  for (const code of ["not-draft", "no-lines", "not-open", "nothing-received", "already-received", "not-part", "unknown-supplier", "bad-line", "pick-variant", "unknown-line", "not-counted", "unknown-item", "unknown-order"]) {
    assert.ok(orderProblem(code), code);
  }
  assert.match(orderProblem("not-open"), /sent/i);
  assert.equal(orderProblem("something else"), null);
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILED` : "all passed");
