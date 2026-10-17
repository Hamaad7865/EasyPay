// journal.test.mjs — the sales journal's money maths (web/lib/journal.ts).
// Every section must foot to the money received, to the cent, and the bridge
// to what was sold must hold: sold = received - earlier + without + on account.
// Usage: node web/lib/journal.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { allocate, buildJournal, compareRange, presets } from "./journal.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures++;
    console.log("FAIL " + name + "\n  " + (e && e.message));
  }
}

const doc = (id, o = {}) => ({ id, number: "S-" + id, type: "sale", total: 11500, tax: 1500, day: "2026-10-10", minute: 600, device: "Counter", employee: "Asha", customer: null, method: null, inPeriod: true, ...o });
const line = (d, o = {}) => ({ doc: d, name: "Toy", category: "Toys", qty: 1000, excl: 10000, tax: 1500, rate: "VAT 15%", ...o });
const cash = (d, amount, o = {}) => ({ doc: d, method: "Cash", amount, by: "Asha", account: false, ...o });
const base = (o) => ({ from: "2026-10-01", to: "2026-10-31", docs: [], lines: [], money: [], without: [], customers: new Map([["c1", "Priya"]]), ...o });

// every section foots to the money received; the bridge holds
function foots(j) {
  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  assert.equal(j.received, j.incl, "received is the headline");
  assert.equal(sum(j.payments, "cents"), j.incl, "payments foot");
  assert.equal(sum(j.methods, "incl"), j.incl, "sale methods foot (incl)");
  assert.equal(sum(j.methods, "excl"), j.excl, "sale methods foot (excl)");
  assert.equal(sum(j.taxes, "incl"), j.incl, "taxes foot (incl)");
  assert.equal(sum(j.taxes, "excl"), j.excl, "taxes foot (excl)");
  assert.equal(sum(j.taxes, "tax"), j.vat, "taxes foot (VAT)");
  assert.equal(sum(j.categories, "incl"), j.incl, "categories foot (incl)");
  assert.equal(sum(j.categories, "excl"), j.excl, "categories foot (excl)");
  assert.equal(sum(j.users, "incl"), j.incl, "users foot (incl)");
  assert.equal(sum(j.users, "excl"), j.excl, "users foot (excl)");
  for (const t of j.taxes) assert.equal(t.incl, t.excl + t.tax, "a tax row: incl = excl + VAT");
  assert.equal(j.sold, j.received - j.earlier + j.without + j.onAccount, "sold = received - earlier + without + on account");
  assert.equal(sum(j.earlierRefs, "cents"), j.earlier);
  assert.equal(sum(j.onAccountRefs, "cents"), j.onAccount);
  assert.equal(sum(j.withoutRefs, "cents"), j.without);
}

check("allocate: exact, proportional, negative, all zero", () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(allocate(-1001, [3, 7, 11]).reduce((a, b) => a + b, 0), -1001);
  assert.deepEqual(allocate(5, [0, 0]), [3, 2]);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocate(7, []), []);
});

check("a sale paid in cash: Rs 115.00, VAT Rs 15.00 in it", () => {
  const j = buildJournal(base({ docs: [doc("a")], lines: [line("a")], money: [cash("a", 11500)] }));
  foots(j);
  assert.deepEqual([j.bills, j.incl, j.excl, j.vat, j.sold, j.onAccount], [1, 11500, 10000, 1500, 11500, 0]);
  assert.deepEqual(j.taxes.map((t) => [t.label, t.excl, t.tax]), [["VAT 15%", 10000, 1500]]);
});

check("a sale put on account, part paid in the period: only the money is takings, the rest is on account", () => {
  const j = buildJournal(base({
    docs: [doc("s", { total: 23000, tax: 3000, customer: "c1" })],
    lines: [line("s"), line("s", { name: "Cot", category: "Furniture" })],
    without: [{ doc: "s", kind: "account", amount: 23000 }],
    money: [cash("s", 10000, { account: true, by: "Ben" })],
  }));
  foots(j);
  assert.deepEqual([j.incl, j.onAccount, j.sold, j.earlier, j.clients], [10000, 13000, 23000, 0, 1]);
  assert.equal(j.onAccountRefs[0].customer, "Priya");
  assert.deepEqual(j.users.map((u) => u.label), ["Ben"]);
});

check("an earlier sale paid on now: takings today, and said apart", () => {
  const j = buildJournal(base({ docs: [doc("old", { inPeriod: false, day: "2026-09-02" })], lines: [line("old")], money: [cash("old", 11500, { account: true })] }));
  foots(j);
  assert.deepEqual([j.incl, j.earlier, j.sold, j.bills], [11500, 11500, 0, 1]);
  assert.equal(j.earlierRefs[0].earlier, true);
});

check("a return of a sale on account: off the bill, in neither money nor what is still owed", () => {
  const j = buildJournal(base({
    docs: [doc("s", { total: 23000, tax: 3000 }), doc("r", { type: "refund", total: 11500, tax: 1500 })],
    lines: [line("s"), line("s"), line("r")],
    without: [{ doc: "s", kind: "account", amount: 23000 }, { doc: "r", kind: "account", amount: 11500, bill: "s" }],
  }));
  foots(j);
  assert.deepEqual([j.incl, j.onAccount, j.without, j.sold], [0, 11500, 0, 11500]);
});

check("a return off an earlier sale's bill: settled without money, negative", () => {
  const j = buildJournal(base({
    docs: [doc("r", { type: "refund" })],
    lines: [line("r")],
    without: [{ doc: "r", kind: "account", amount: 11500, bill: "elsewhere" }],
  }));
  foots(j);
  assert.deepEqual([j.without, j.sold], [-11500, -11500]);
});

check("an exchange: only the difference paid in cash is takings", () => {
  const j = buildJournal(base({
    docs: [doc("r", { type: "refund", total: 5000, tax: 652 }), doc("n", { total: 8000, tax: 1043 })],
    lines: [line("r", { excl: 4348, tax: 652 }), line("n", { excl: 6957, tax: 1043 })],
    without: [{ doc: "r", kind: "exchange", amount: 5000 }, { doc: "n", kind: "exchange", amount: 5000 }],
    money: [cash("n", 3000)],
  }));
  foots(j);
  assert.deepEqual([j.incl, j.without, j.sold], [3000, 0, 3000]);
});

check("money back on a refund is negative takings", () => {
  const j = buildJournal(base({
    docs: [doc("a"), doc("r", { type: "refund" })],
    lines: [line("a"), line("r")],
    money: [cash("a", 11500), cash("r", -11500)],
  }));
  foots(j);
  assert.deepEqual([j.incl, j.excl, j.sold, j.bills], [0, 0, 0, 1]);
});

check("filters: a till, a person, an item, the hours; every section still foots", () => {
  const input = base({
    docs: [doc("a"), doc("b", { device: "Back", employee: "Ben", minute: 1000 }), doc("c", { inPeriod: false })],
    lines: [line("a"), line("b", { name: "Cot" }), line("c")],
    money: [cash("a", 11500), cash("b", 11500), cash("c", 11500, { account: true })],
  });
  for (const filters of [{ device: "Counter" }, { user: "Ben" }, { item: "Cot" }, { from: 900, to: 1100 }, {}]) {
    const j = buildJournal({ ...input, filters });
    foots(j);
  }
  assert.equal(buildJournal({ ...input, filters: { device: "Back" } }).incl, 11500);
  assert.equal(buildJournal({ ...input, filters: { item: "Toy" } }).incl, 11500, "an earlier sale is left out when an item is asked for");
});

// many sales, odd amounts, two rates, discounts, part payments, refunds, accounts: the invariants hold every time
check("five hundred random periods foot to the cent", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 500; k++) {
    const docs = [], lines = [], money = [], without = [];
    const n = 1 + rnd(12);
    for (let i = 0; i < n; i++) {
      const id = "d" + i;
      const refund = rnd(5) === 0;
      const inPeriod = rnd(6) !== 0;
      const nl = 1 + rnd(4);
      let excl = 0, tax = 0;
      for (let q = 0; q < nl; q++) {
        const e = 1 + rnd(50000), rate = [0, 1500, 500][rnd(3)];
        const t = Math.round((e * rate) / 10000);
        excl += e; tax += t;
        lines.push({ doc: id, name: "I" + rnd(4), category: rnd(4) === 0 ? null : "C" + rnd(3), qty: 1000 * (1 + rnd(3)), excl: e, tax: t, rate: rate ? "VAT " + rate / 100 + "%" : "No tax" });
      }
      const total = excl + tax - rnd(200); // a discount or a rounding off the lines
      docs.push({ id, number: "N" + i, type: refund ? "refund" : "sale", total, tax, day: inPeriod ? "2026-10-05" : "2026-09-05", minute: rnd(1440), device: ["A", "B"][rnd(2)], employee: ["X", "Y", null][rnd(3)], customer: rnd(2) ? "c1" : null, method: null, inPeriod });
      // how it was paid: money, without money, on account (a sale), in any mix
      const acct = refund ? 0 : rnd(3) === 0 ? rnd(total + 1) : 0;
      const wo = rnd(4) === 0 ? rnd(total - acct + 1) : 0;
      const m = total - acct - wo;
      if (inPeriod) {
        if (acct) without.push({ doc: id, kind: "account", amount: acct });
        if (wo) without.push({ doc: id, kind: refund ? "credit_note" : "deposit", amount: wo });
        if (m) money.push({ doc: id, method: ["Cash", "Card"][rnd(2)], amount: refund ? -m : m, by: "X", account: false });
      }
      if (!refund && (acct || !inPeriod) && rnd(2)) money.push({ doc: id, method: "Cash", amount: 1 + rnd(Math.max(1, inPeriod ? acct : total)), by: "Y", account: true });
    }
    const filters = [{}, { device: "A" }, { user: "X" }, { from: 300, to: 900 }][rnd(4)];
    try {
      foots(buildJournal({ from: "2026-10-01", to: "2026-10-31", docs, lines, money, without, customers: new Map(), filters }));
    } catch (e) {
      throw new Error(`period ${k}: ${e.message}`);
    }
  }
});

check("periods: presets and comparisons", () => {
  const p = Object.fromEntries(presets("2026-03-31").map((x) => [x.key, x.range]));
  assert.deepEqual(p.yesterday, { from: "2026-03-30", to: "2026-03-30" });
  assert.deepEqual(p["current-month"], { from: "2026-03-01", to: "2026-03-31" });
  assert.deepEqual(p["previous-month"], { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(presets("2026-01-15").find((x) => x.key === "previous-month").range, { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(compareRange("previous-period", { from: "2026-10-08", to: "2026-10-14" }), { from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual(compareRange("previous-month", { from: "2026-03-01", to: "2026-03-31" }), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(compareRange("previous-month", { from: "2026-03-31", to: "2026-03-31" }), { from: "2026-02-28", to: "2026-02-28" });
  assert.deepEqual(compareRange("previous-year", { from: "2024-02-29", to: "2024-02-29" }), { from: "2023-02-28", to: "2023-02-28" });
  assert.equal(compareRange("none", { from: "2026-01-01", to: "2026-01-01" }), null);
});

console.log(failures ? `${failures} FAILED` : "JOURNAL PASS");
process.exit(failures ? 1 : 0);
