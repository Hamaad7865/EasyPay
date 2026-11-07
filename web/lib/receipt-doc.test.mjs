// receipt-doc.test.mjs — a receipt put together again from the server's rows
// prints as the till's copy of it does (web/lib/receipt-doc.ts; the Receipts
// pop-up, docs/superpowers/specs/2026-11-07-receipts-popup-design.md).
// Usage: node web/lib/receipt-doc.test.mjs   (Node runs the .ts files itself)
import assert from "node:assert/strict";
import { EASYPAY, renderReceipt } from "./papers.ts";
import { customerNo, lineAmount, orderName, paperText, receiptDoc, remark, shopOf, taxLines, whatsappNumber } from "./receipt-doc.ts";

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

const VAT = { tax_id: "t-vat", name: "VAT", rate_bp: 1500, type: "included" };
const head = (over = {}) => ({
  number: "S1-T1-000128", type: "sale", at: "2026-11-06T07:43:24.000Z",
  subtotal: 80000, discount_total: 0, tax_total: 10435, service_charge: 0, rounding: 0, total: 80000,
  table_id: null, table_name: null, order_no: null, order_name: null, note: null, phone: null, address: null,
  covers: null, dining: null, cashier: "Priya", waiter: null, customer: null, refund_number: null,
  points_earned: 0, points_used: 0, refunded: 0, ...over,
});
// 2 x Cari poulet at 380.00 with Extra rice 40.00 for the line: the server's own example (receipt-deltas T3)
const cari = { name: "Cari poulet", unit_price: 38000, qty: 2000, list_price: null, price_label: null, addons: [{ name: "Extra rice", qty: 1, price: 4000 }], taxes: [VAT] };

check("a line is rounded as the till rounds it", () => {
  assert.equal(lineAmount(38000, 2000), 76000);
  assert.equal(lineAmount(9999, 500), 5000); // 4999.5 goes up
  assert.equal(lineAmount(12345, 333), 4111);
});

check("the tax inside the prices, as the server worked it out (10435 on 800.00)", () => {
  assert.deepEqual(taxLines([cari], head()), [{ name: "VAT", rateBp: 1500, amount: 10435, included: true }]);
});

check("each line's share of the discount comes off before its tax; the lines add up to the stored tax", () => {
  const a = { ...cari, addons: [], qty: 1000, unit_price: 10000 };
  const b = { ...cari, name: "Alouda", addons: [], qty: 1000, unit_price: 5000, taxes: [{ tax_id: "t-x", name: "Levy", rate_bp: 500, type: "added" }] };
  // 100.00 with VAT inside and 50.00 with a 5% levy on top; 30.00 off the bill: 20.00 off the first, 10.00 off the second.
  // VAT in 80.00 is 10.43, the levy on 40.00 is 2.00; the stored tax says 12.44, so the cent left over goes on VAT.
  const h = head({ subtotal: 15000, discount_total: 3000, tax_total: 1244, total: 15000 - 3000 + 200 });
  const t = taxLines([a, b], h);
  assert.deepEqual(t, [{ name: "VAT", rateBp: 1500, amount: 1044, included: true }, { name: "Levy", rateBp: 500, amount: 200, included: false }]);
  assert.equal(t.reduce((s, x) => s + x.amount, 0), h.tax_total);
});

check("what rounding leaves over goes on the largest tax", () => {
  const t = taxLines([cari], head({ tax_total: 10436 }));
  assert.equal(t[0].amount, 10436);
});

check("a receipt whose lines say nothing of tax has one line, as the till's copy has", () => {
  const plain = { ...cari, taxes: [] };
  assert.deepEqual(taxLines([plain], head()), [{ name: "Tax", rateBp: 0, amount: 10435, included: true }]);
  assert.deepEqual(taxLines([plain], head({ tax_total: 0 })), []);
  assert.equal(taxLines([plain], head({ total: 92000, tax_total: 12000 }))[0].included, false);
});

check("the order's name: a table, else its number and who it is for, else a direct sale", () => {
  assert.equal(orderName({ table_name: "4", order_no: "D-03", order_name: null, customer: null }), "Table 4");
  assert.equal(orderName({ table_name: "Terrace", order_no: null, order_name: null, customer: null }), "Terrace");
  assert.equal(orderName({ table_name: null, order_no: "A-05", order_name: "Ravi", customer: "Ravi Doorga" }), "A-05 · Ravi");
  assert.equal(orderName({ table_name: null, order_no: null, order_name: null, customer: "Ravi Doorga" }), "Ravi Doorga");
  assert.equal(orderName({ table_name: null, order_no: null, order_name: null, customer: null }), "Direct sale");
});

check("the customer number: a restaurant's order with no table; never a shop's", () => {
  assert.equal(customerNo("A-05", null, false), "05");
  assert.equal(customerNo("A-05", "table-1", false), null);
  assert.equal(customerNo("C-05", null, true), null);
  assert.equal(customerNo("Ravi", null, false), null);
  assert.equal(customerNo(null, null, false), null);
});

check("the remark carries who to ring and where it goes", () => {
  assert.equal(remark({ note: "Ring at the gate", phone: "5123 4567", address: "Royal Road" }), "Ring at the gate · Tel 5123 4567 · Royal Road");
  assert.equal(remark({ note: null, phone: null, address: null }), null);
});

check("a copy says COPY, what was refunded since, and leaves out that day's balances", () => {
  const d = receiptDoc(head({ refunded: 20000 }), [cari], [], [{ name: "Cash", amount: 80000, tendered: 100000, change: 20000, reference: null }], false);
  assert.equal(d.reprint, true);
  assert.equal(d.refunded, 20000);
  assert.equal(d.refundedAll, false);
  assert.equal(d.owed, null);
  assert.equal(d.pointsBalance, null);
  assert.equal(receiptDoc(head({ refunded: 80000 }), [cari], [], [], false).refundedAll, true);
});

check("a refund names the sale and the points it took back and gave back", () => {
  const d = receiptDoc(head({ type: "refund", refund_number: "S1-T1-000120", points_earned: -800, points_used: -300, order_no: "A-05" }), [cari], [], [], false);
  assert.equal(d.kind, "refund");
  assert.equal(d.refundOf, "S1-T1-000120");
  assert.equal(d.pointsTaken, 800);
  assert.equal(d.pointsBack, 300);
  assert.equal(d.pointsEarned, null);
  assert.equal(d.customerNo, null);
  assert.equal(d.refunded, 0);
});

check("a shop's receipt has no table things: no order type, waiter or guests", () => {
  const d = receiptDoc(head({ dining: "Dine-in", waiter: "Ali", covers: 2 }), [cari], [], [], true);
  assert.equal(d.dining, null);
  assert.equal(d.waiter, null);
  assert.equal(d.covers, null);
});

const S = { company: { name: "", address: "Royal Road", phone: "212 0000", brn: "", vat: "VAT1" }, receipt: { header: "", footer: "Thank you" } };
check("the business on the paper: its name, else the account's; a branch's own address with several", () => {
  const one = shopOf(S, { name: "Star Grill", brn: "C123", vat: null }, { name: "Port Louis", address: "Corderie St", phone: null }, false, false);
  assert.equal(one.name, "Star Grill");
  assert.equal(one.brn, "C123");
  assert.equal(one.vat, "VAT1");
  assert.equal(one.address, "Royal Road");
  assert.equal(one.branch, "");
  const many = shopOf(S, { name: "Star Grill", brn: null, vat: null }, { name: "Port Louis", address: "Corderie St", phone: "  " }, true, true);
  assert.equal(many.branch, "Port Louis");
  assert.equal(many.address, "Corderie St");
  assert.equal(many.phone, "212 0000");
  assert.equal(many.bars, true);
});

check("the paper prints as the till's copy: COPY, the lines, the tax, the total", () => {
  const d = receiptDoc(head({ refunded: 20000 }), [cari], [], [{ name: "Cash", amount: 80000, tendered: 100000, change: 20000, reference: null }], false);
  const text = paperText(renderReceipt(EASYPAY.receipt, d, shopOf(S, { name: "Star Grill", brn: null, vat: null }, null, false, false), 48, 2), 48);
  for (const want of ["RECEIPT", "COPY", "*** PARTLY REFUNDED: 200.00 ***", "S1-T1-000128", "Extra rice", "VAT 15% (incl.)", "104.35", "Rs 800.00", "Thank you"]) assert.ok(text.includes(want), "missing " + want + "\n" + text);
  // each line as wide as the paper at most
  assert.ok(text.split("\n").every((l) => l.length <= 48), text);
});

check("text keeps a centred line in the middle", () => {
  assert.equal(paperText([{ t: "COPY", size: "normal", bold: true, align: "center" }], 10), "   COPY");
  assert.equal(paperText([{ t: "1.00", size: "normal", bold: false, align: "right" }], 8), "    1.00");
  // a Big name is in the middle of the text, which has no large letters
  assert.equal(paperText([{ t: "Star", size: "big", bold: false, align: "center" }], 12), "    Star");
  assert.equal(paperText([{ t: "", size: "normal", bold: false, align: "center", bars: "X1" }, { t: "X1", size: "normal", bold: false, align: "center" }], 6), "  X1");
});

check("a number as WhatsApp takes it", () => {
  assert.equal(whatsappNumber("5250 1234"), "23052501234");
  assert.equal(whatsappNumber("212 0000"), "2302120000");
  assert.equal(whatsappNumber("+230 5250 1234"), "23052501234");
  assert.equal(whatsappNumber("00 44 7700 900123"), "447700900123");
  assert.equal(whatsappNumber("123"), null);
  assert.equal(whatsappNumber(null), null);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
