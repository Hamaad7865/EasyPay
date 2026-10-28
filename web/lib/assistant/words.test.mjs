// words.test.mjs — how the assistant reads the owner's words against a shop's spellings.
// Usage: node web/lib/assistant/words.test.mjs
import assert from "node:assert/strict";
import { cents, groups, key, read, thousandths, titled } from "./words.ts";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); } catch (e) { failures++; console.log("FAIL " + name + " " + e.message); }
}

// Kids Corner's own styles and colours, with how many lines use each (production, 2026-10-28)
const styles = [
  { value: "stripe", lines: 56 }, { value: "Stripes", lines: 22 }, { value: "Stripe", lines: 2 }, { value: "Striped", lines: 1 }, { value: "stripes", lines: 1 },
  { value: "Plain", lines: 76 }, { value: "plain", lines: 74 }, { value: "Design", lines: 22 }, { value: "design", lines: 5 }, { value: "designed", lines: 2 },
];

check("one key for stripe, Stripes, Striped", () => {
  assert.equal(key("stripe"), key("Stripes"));
  assert.equal(key("Striped"), key("stripe"));
  assert.equal(key("design"), key("designed"));
  assert.notEqual(key("Plain"), key("Design"));
});
check("sizes and colours compare without spaces or case", () => {
  assert.equal(key("3 - 6m"), key("3-6m"));
  assert.equal(key("Pale blue"), key("pale Blue"));
  assert.equal(key("Petrol  Blue"), key("petrol blue"));
  assert.notEqual(key("1"), key("10"));
  assert.notEqual(key("1-2"), key("12"));
  assert.notEqual(key("3-4"), key("34"));
  assert.equal(key("12-18m"), key("12 - 18M"));
});
check("striped is the stripe most lines say, with the others named", () => {
  const r = read("striped", styles);
  assert.equal(r.value, "stripe");
  assert.equal(r.lines, 56);
  assert.deepEqual(r.also.map((x) => x.value), ["Stripes", "Stripe", "Striped", "stripes"]);
});
check("a word that matches nothing is new", () => {
  assert.equal(read("Colle Mao", styles), null);
  assert.equal(read("", styles), null);
});
check("titled writes each word with a capital and leaves sizes", () => {
  assert.equal(titled("pale blue"), "Pale Blue");
  assert.equal(titled("white/navy blue"), "White/Navy Blue");
  assert.equal(titled("3-6m"), "3-6m");
  assert.equal(titled("3 - 6m"), "3-6m");
  assert.equal(titled("  green   mint "), "Green Mint");
});
check("groups gather the spellings of one thing, biggest first", () => {
  const g = groups(styles);
  assert.deepEqual(g.map((x) => [x.to, x.lines]), [["Plain", 150], ["Stripe", 82], ["Design", 29]]);
  assert.deepEqual(g[1].from.map((x) => x.value), ["stripe", "Stripes", "Stripe", "Striped", "stripes"]);
});
check("pieces and rupees in the units the database keeps", () => {
  assert.equal(thousandths(5), 5000);
  assert.equal(thousandths(1.5), 1500);
  assert.equal(cents(875), 87500);
});

console.log(failures === 0 ? "WORDS PASS" : `WORDS FAIL (${failures})`);
process.exit(failures ? 1 : 0);
