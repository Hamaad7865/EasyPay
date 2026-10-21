// mra.test.mjs — what the back office and /admin say about a client's MRA
// (web/lib/mra.ts, migration 0116).
// Usage: node web/lib/mra.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { asMra, checklistWords, isMraCode, MRA_CODES, MRA_MOVES, mraNotice, onMra, suggestCode, testAtMra, tillConnected } from "./mra.ts";

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
  assert.match(by.login.detail, /Settings, MRA/);
  assert.ok(lines.every((l) => l.title.length > 5));
});

check("one item without a tax is said in the singular", () => {
  const [l] = checklistWords([{ key: "items", ok: false, count: 1 }]);
  assert.equal(l.detail, "1 item has no tax.");
});

// 0132: training and live, and the tills' own connection to the MRA
check("the moves /admin offers from each state", () => {
  assert.deepEqual(MRA_MOVES.off, []);
  assert.deepEqual(MRA_MOVES.setting_up, ["training"]);
  assert.deepEqual(MRA_MOVES.training, ["setting_up", "live"]);
  assert.deepEqual(MRA_MOVES.live, []);
});

check("what /admin says once a client has moved", () => {
  assert.match(mraNotice("training"), /TRN/);
  assert.match(mraNotice("live"), /next sale/);
  assert.match(mraNotice("off"), /Premium/);
  assert.match(mraNotice("setting_up"), /stop/);
});

check("a till is connected when it last said it was signed in and was not refused", () => {
  assert.equal(tillConnected({ connected: true, refused: null }), true);
  assert.equal(tillConnected({ connected: true, refused: "Invalid User" }), false);
  assert.equal(tillConnected({ connected: false }), false);
  assert.equal(tillConnected(null), false);
});

check("the tills' login line counts the tills connected", () => {
  const by = (t) => Object.fromEntries(checklistWords([], t).map((l) => [l.key, l]));
  assert.equal(by({ connected: 2, total: 2 }).login.ok, true);
  assert.match(by({ connected: 1, total: 2 }).login.detail, /^1 of 2 tills connected/);
  assert.equal(by({ connected: 0, total: 0 }).login.ok, false);
  assert.equal(by(undefined).login.ok, false);
});

// a client live with us whose till the MRA still answers as TEST: its sales do not count
check("a live client's till the MRA counts as TEST is flagged", () => {
  assert.equal(testAtMra("live", { environment: "TEST" }), true);
  assert.equal(testAtMra("live", { environment: "LIVE" }), false);
  assert.equal(testAtMra("training", { environment: "TEST" }), false);
  assert.equal(testAtMra("live", null), false);
  assert.equal(testAtMra("live", { connected: true }), false);
});

console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
