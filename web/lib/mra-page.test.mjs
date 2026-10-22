// mra-page.test.mjs — what the back office's MRA page says (web/lib/mra-page.ts).
// Usage: node web/lib/mra-page.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { attention, csvLine, mraFilters, mraQuery, MRA_TYPES, reasons, signedCents, statusWords, WAITING_HOURS } from "./mra-page.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + (e && e.message ? e.message.split("\n")[0] : e));
  }
}

const ID = "3b774aab-4c3f-43cf-83ed-47ef5f4c6639";
const from = (o) => (k) => o[k] ?? "";

check("M1 the filters keep only what they should", () => {
  assert.deepEqual(mraFilters(from({ store: ID, till: "nope", type: "CRN", status: "waiting", from: "2026-10-22", to: "22/10/2026" })),
    { store: ID, till: null, type: "CRN", status: "waiting", from: "2026-10-22", to: null });
  assert.deepEqual(mraFilters(from({ type: "XYZ", status: "unsure" })), { store: null, till: null, type: null, status: null, from: null, to: null });
  assert.equal(mraFilters(from({ from: "2026-02-31" })).from, null);
  assert.equal(mraFilters(from({ from: "2026-13-45" })).from, null);
});

check("M1 the filters back as the end of an address", () => {
  assert.equal(mraQuery({ store: null, till: null, type: "STD", status: null, from: "2026-10-01", to: null }), "?type=STD&from=2026-10-01");
  assert.equal(mraQuery({ store: null, till: null, type: null, status: null, from: null, to: null }), "");
});

check("M2 every type and status has its words", () => {
  assert.equal(MRA_TYPES.CRN, "Credit note");
  assert.equal(MRA_TYPES.TRN, "Training");
  assert.equal(statusWords("fiscalised"), "Fiscalised");
  assert.equal(statusWords("unsure"), "Sent, no answer yet");
  assert.equal(statusWords("check"), "Sent twice, no answer: check it on the till");
  assert.equal(statusWords("something new"), "something new");
});

check("M3 a credit note reads with a minus; the others as sent", () => {
  assert.equal(signedCents("CRN", "57.50"), -5750);
  assert.equal(signedCents("STD", "480.00"), 48000);
  assert.equal(signedCents("STD", "0.1"), 10);
  assert.equal(signedCents("STD", null), null);
  assert.equal(signedCents("STD", "abc"), null);
});

check("M4 the MRA's reasons, one line", () => {
  assert.equal(reasons(["ERR0500: TAN of registered user does not match", "ERR0600: Invalid seller BRN"]), "ERR0500: TAN of registered user does not match; ERR0600: Invalid seller BRN");
  assert.equal(reasons([]), "");
  assert.equal(reasons(null), "");
});

const now = new Date("2026-10-22T18:00:00Z");
const fine = { connected: true, refusedLogin: null, waiting: 0, oldestWaiting: null, check: 0, countedAsTest: false };

check("M5 a till that is fine needs nothing", () => {
  assert.deepEqual(attention(fine, now), []);
  assert.deepEqual(attention({ ...fine, waiting: 3, oldestWaiting: new Date(now.getTime() - 60 * 60_000) }, now), []);
});

check("M5 what makes a till need attention, in words", () => {
  assert.deepEqual(attention({ ...fine, connected: false, refusedLogin: "Wrong password" }, now), ["The MRA refused its login: Wrong password"]);
  assert.deepEqual(attention({ ...fine, connected: false }, now), ["Not signed in to the MRA"]);
  assert.deepEqual(attention({ ...fine, countedAsTest: true }, now), ["The MRA counts its sales as TEST"]);
  assert.deepEqual(attention({ ...fine, check: 2 }, now), ["2 sent twice with no answer: check them on the till"]);
  assert.deepEqual(attention({ ...fine, waiting: 4, oldestWaiting: new Date(now.getTime() - (WAITING_HOURS * 60 + 1) * 60_000) }, now),
    [`4 waiting for more than ${WAITING_HOURS} hours`]);
});

check("M6 a CSV line quotes what needs it", () => {
  assert.equal(csvLine(["2026-10-22 21:30", "Main store", "Till 1", "MP-T1-R000027", "Credit note", "-57.50", "Fiscalised", 'He said "no", then yes', ""]),
    '2026-10-22 21:30,Main store,Till 1,MP-T1-R000027,Credit note,-57.50,Fiscalised,"He said ""no"", then yes",');
  assert.equal(csvLine([null, undefined, "a;b"]), ',,"a;b"');
});

if (failures) {
  console.log(failures + " failed");
  process.exit(1);
}
console.log("all passed");
