// mra.test.mjs — what the back office and /admin say about a client's MRA
// (web/lib/mra.ts, migration 0116).
// Usage: node web/lib/mra.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { asMra, checklistWords, isMraCode, MRA_CODES, onMra, suggestCode } from "./mra.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures++;
    console.log("FAIL " + name + "\n  " + e.message);
  }
}

check("a state read from the database is one of the four, anything else is off", () => {
  assert.equal(asMra("setting_up"), "setting_up");
  assert.equal(asMra("live"), "live");
  assert.equal(asMra("LIVE"), "off");
  assert.equal(asMra(null), "off");
  assert.equal(onMra("off"), false);
  assert.equal(onMra("setting_up"), true);
});

check("the six MRA codes, TC01 to TC06, each with words", () => {
  assert.deepEqual(MRA_CODES.map(([c]) => c), ["TC01", "TC02", "TC03", "TC04", "TC05", "TC06"]);
  assert.ok(MRA_CODES.every(([, words]) => words.length > 3));
  assert.equal(isMraCode("TC03"), true);
  assert.equal(isMraCode("TC07"), false);
  assert.equal(isMraCode(""), false);
});

check("the code suggested for a tax: 15% TC01, 0% TC02, 0% named exempt TC03, anything else none", () => {
  assert.equal(suggestCode(1500, "VAT"), "TC01");
  assert.equal(suggestCode(0, "Zero rated"), "TC02");
  assert.equal(suggestCode(0, "Exempt"), "TC03");
  assert.equal(suggestCode(0, "VAT exempt items"), "TC03");
  assert.equal(suggestCode(1000, "Other"), null);
});

check("each line of the checklist in words, with what is missing", () => {
  const lines = checklistWords([
    { key: "company", ok: false, missing: ["TAN", "BRN"] },
    { key: "nature", ok: true },
    { key: "addresses", ok: false, missing: ["Main", "Flacq"] },
    { key: "taxes", ok: false, missing: ["VAT"] },
    { key: "items", ok: false, count: 12 },
    { key: "tills", ok: false, missing: ["Till 1"] },
  ]);
  assert.equal(lines.length, 7, "the six from the database and the MRA login");
  const by = Object.fromEntries(lines.map((l) => [l.key, l]));
  assert.equal(by.company.detail, "Missing: TAN, BRN.");
  assert.equal(by.nature.ok, true);
  assert.equal(by.nature.detail, "");
  assert.equal(by.addresses.detail, "No address: Main, Flacq.");
  assert.equal(by.taxes.detail, "No code: VAT.");
  assert.equal(by.items.detail, "12 items have no tax.");
  assert.equal(by.tills.detail, "No ID: Till 1.");
  assert.equal(by.login.ok, false);
  assert.match(by.login.detail, /connection/);
  assert.ok(lines.every((l) => l.title.length > 5));
});

check("one item without a tax is said in the singular", () => {
  const [l] = checklistWords([{ key: "items", ok: false, count: 1 }]);
  assert.equal(l.detail, "1 item has no tax.");
});

console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
