// invoice-money.test.mjs — an invoice's figures follow the till's own rules (web/lib/invoice-money.ts,
// docs/superpowers/specs/2026-11-12-invoices-design.md §2.1), and where an invoice stands is worked out
// from its payments and its due day.
// Usage: node web/lib/invoice-money.test.mjs   (Node runs the .ts files itself; the hook below lets a
// .ts file name another without its extension, as Next does)
import assert from "node:assert/strict";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.startsWith(".") && !/\\.[a-z]+$/.test(s)) return next(s + ".ts", c); throw e; } }`,
    ),
);
const { figures, discountOf, exclOf, priceAfter, percentOff, dueOf, stateOf, daysLate, parseQty, qtyText, lineFits } = await import("./invoice-money.ts");
const { taxLines, lineAmount } = await import("./receipt-doc.ts");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + "\n  " + (e && e.message));
  }
}

const vat15in = { tax_id: "t1", name: "VAT", rate_bp: 1500, type: "included" };
const vat15on = { tax_id: "t2", name: "VAT", rate_bp: 1500, type: "added" };
const zero = { tax_id: "t3", name: "Zero rated", rate_bp: 0, type: "included" };

check("M1 one line, VAT inside the price: the total is the price, the VAT is the part of it that is tax", () => {
  const f = figures([{ qty: 1000, unit_price: 11500, taxes: [vat15in] }], { type: "amount", value: 0 });
  assert.deepEqual([f.subtotal, f.discount, f.taxAdded, f.taxIncluded, f.total], [11500, 0, 0, 1500, 11500]);
});

check("M2 VAT added on top: the total carries it", () => {
  const f = figures([{ qty: 2000, unit_price: 10000, taxes: [vat15on] }], { type: "amount", value: 0 });
  assert.deepEqual([f.subtotal, f.taxAdded, f.total], [20000, 3000, 23000]);
});

check("M3 a percent discount is rounded as a receipt's and spread over the lines, truncated", () => {
  const lines = [
    { qty: 1000, unit_price: 33333, taxes: [vat15in] },
    { qty: 3000, unit_price: 1999, taxes: [vat15on] },
    { qty: 250, unit_price: 12000, taxes: [] },
  ];
  const f = figures(lines, { type: "percent", value: 7 });
  const sub = 33333 + 5997 + 3000;
  assert.equal(f.subtotal, sub);
  assert.equal(f.discount, Math.floor((sub * 7 + 50) / 100));
  // by hand: line 2's net and its tax on top
  const net2 = 5997 - Math.floor((f.discount * 5997) / sub);
  assert.equal(f.nets[1], net2);
  assert.equal(f.taxAdded, Math.floor((net2 * 1500 + 5000) / 10000));
  assert.equal(f.total, sub - f.discount + f.taxAdded);
});

check("M4 the same figures as the Receipts pop-up's tax lines for the same lines (one rule, not two)", () => {
  const lines = [
    { qty: 1000, unit_price: 45000, taxes: [vat15in] },
    { qty: 2500, unit_price: 3990, taxes: [vat15in] },
    { qty: 1000, unit_price: 9900, taxes: [zero] },
  ];
  const f = figures(lines, { type: "amount", value: 2500 });
  const asReceipt = lines.map((l) => ({ name: "x", unit_price: l.unit_price, qty: l.qty, list_price: null, price_label: null, addons: [], taxes: l.taxes }));
  const t = taxLines(asReceipt, { subtotal: f.subtotal, discount_total: f.discount, tax_total: f.taxTotal, service_charge: 0, rounding: 0, total: f.total });
  assert.equal(t.reduce((s, x) => s + x.amount, 0), f.taxTotal);
  assert.equal(t.find((x) => x.name === "VAT").amount, f.taxes.find((x) => x.key === "t1").amount);
  assert.equal(f.subtotal, lines.reduce((s, l) => s + lineAmount(l.unit_price, l.qty), 0));
});

check("M5 an amount discount is never more than the lines; a percent never more than 100", () => {
  assert.equal(discountOf(5000, { type: "amount", value: 9000 }), 5000);
  assert.equal(discountOf(5000, { type: "percent", value: 250 }), 5000);
  assert.equal(discountOf(0, { type: "percent", value: 10 }), 0);
  assert.equal(figures([], { type: "amount", value: 100 }).total, 0);
});

check("M6 a large invoice keeps every cent of its discount spread (whole numbers past 2^53)", () => {
  const lines = [
    { qty: 1000000, unit_price: 9999999, taxes: [vat15on] },
    { qty: 1000, unit_price: 7, taxes: [vat15on] },
  ];
  const f = figures(lines, { type: "percent", value: 3 });
  const base = lineAmount(9999999, 1000000);
  const share = (BigInt(f.discount) * BigInt(base)) / BigInt(f.subtotal);
  assert.equal(f.nets[0], base - Number(share));
});

check("M7 shown without VAT: a price with VAT inside loses it, one with VAT on top is as it is", () => {
  assert.equal(exclOf(11500, [vat15in]), 10000);
  assert.equal(exclOf(10000, [vat15on]), 10000);
  assert.equal(exclOf(10000, []), 10000);
});

check("M8 a line's discount is a lower price, and the lower price says its percent", () => {
  assert.equal(priceAfter(10000, 1250), 8750);
  assert.equal(priceAfter(999, 1000), 899);
  assert.equal(percentOff(10000, 8750), 1250);
  assert.equal(percentOff(10000, 12000), 0);
});

check("M9 due days: on receipt, in days, at the end of the month, on a date", () => {
  assert.equal(dueOf("2026-11-12", "receipt", null), "2026-11-12");
  assert.equal(dueOf("2026-11-12", "30", null), "2026-12-12");
  assert.equal(dueOf("2026-01-31", "eom", null), "2026-01-31");
  assert.equal(dueOf("2026-02-10", "eom", null), "2026-02-28");
  assert.equal(dueOf("2026-11-12", "date", "2026-12-01"), "2026-12-01");
  assert.equal(dueOf("2026-11-12", "date", "2026-11-01"), "2026-11-12");
});

check("M10 where an invoice stands comes from its payments and its due day", () => {
  const t = "2026-11-12";
  assert.equal(stateOf({ status: "draft", total: 100, paid: 0, due_on: null }, t), "draft");
  assert.equal(stateOf({ status: "issued", total: 100, paid: 0, due_on: "2026-11-30" }, t), "issued");
  assert.equal(stateOf({ status: "issued", total: 100, paid: 40, due_on: "2026-11-30" }, t), "part");
  assert.equal(stateOf({ status: "issued", total: 100, paid: 40, due_on: "2026-11-11" }, t), "overdue");
  assert.equal(stateOf({ status: "issued", total: 100, paid: 100, due_on: "2026-11-01" }, t), "paid");
  assert.equal(stateOf({ status: "issued", total: 0, paid: 0, due_on: "2026-11-01" }, t), "paid");
  assert.equal(daysLate("2026-11-02", t), 10);
  assert.equal(daysLate("2026-11-30", t), 0);
});

check("M11 quantities as typed, in thousandths", () => {
  assert.equal(parseQty("2"), 2000);
  assert.equal(parseQty("2.5"), 2500);
  assert.equal(parseQty("1,25"), 1250);
  assert.equal(parseQty(".5"), 500);
  assert.equal(parseQty("2.5555"), null);
  assert.equal(parseQty("abc"), null);
  assert.equal(qtyText(2500), "2.5");
  assert.equal(qtyText(3000), "3");
  assert.equal(lineFits(9999999, 1000000), true);
  assert.equal(lineFits(10 ** 12, 10 ** 9), false);
});

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
