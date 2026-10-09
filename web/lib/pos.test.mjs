// pos.test.mjs — what the Point of sale pages work out with no database (web/lib/pos.ts):
// a till's tab, where an old address goes now, a count against what was
// expected, the timeline by day, the payments in and out, an event in words.
// Usage: node web/lib/pos.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { REQUEST_BUILD, askEnded, askSays, byDay, eventDetail, movedTo, refusal, splitMoves, tabOf, takesRequests, variance } from "./pos.ts";

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
const TILL = "0b2f6c1e-7a44-4d0b-9d5e-2f8a1c3b4d5e";

check("a till's page opens on General, and on the tab asked for when there is one", () => {
  assert.equal(tabOf(undefined), "general");
  assert.equal(tabOf("cash"), "cash");
  assert.equal(tabOf("trace"), "trace");
  assert.equal(tabOf("settings"), "settings");
  assert.equal(tabOf("nonsense"), "general");
});

check("the old Tills page is the cards now", () => {
  assert.equal(movedTo("tills", {}), "/backoffice/pos");
  assert.equal(movedTo("tills", { till: TILL }), "/backoffice/pos");
});

check("the old Till activity goes to that till's Traceability, on the day it asked for", () => {
  assert.equal(movedTo("activity", { till: TILL, day: "2026-10-08" }), `/backoffice/pos/${TILL}?tab=trace&from=2026-10-08&to=2026-10-08`);
  assert.equal(movedTo("activity", { till: TILL }), `/backoffice/pos/${TILL}?tab=trace`);
  // a day that is not written as one is left out, and the page opens on today
  assert.equal(movedTo("activity", { till: TILL, day: "yesterday" }), `/backoffice/pos/${TILL}?tab=trace`);
});

check("the old Cash flow goes to that till's Cash flow", () => {
  assert.equal(movedTo("cash", { till: TILL, day: "anything" }), `/backoffice/pos/${TILL}?tab=cash`);
});

check("with no till named, or something that is not a till's id, an old address goes to the cards", () => {
  assert.equal(movedTo("activity", { day: "2026-10-08" }), "/backoffice/pos");
  assert.equal(movedTo("cash", {}), "/backoffice/pos");
  assert.equal(movedTo("cash", { till: "../admin" }), "/backoffice/pos");
});

check("a count against what was expected: balanced, short or over", () => {
  assert.deepEqual(variance("118000", "118000"), { off: 0, tone: "green", word: "Balanced" });
  assert.deepEqual(variance("117000", "118000"), { off: -1000, tone: "red", word: "Short" });
  assert.deepEqual(variance(118500, 118000), { off: 500, tone: "amber", word: "Over" });
  // a day that was not counted has nothing to say
  assert.equal(variance(null, "118000"), null);
  assert.equal(variance("118000", null), null);
});

check("the timeline keeps its order and puts each event under its day in the business's own timezone", () => {
  // Mauritius is four hours ahead: 20:01 UTC on the 9th is one minute past midnight on the 10th there
  const events = [{ at: "2026-10-09T20:01:00Z", n: 3 }, { at: "2026-10-09T19:59:00Z", n: 2 }, { at: "2026-10-09T05:00:00Z", n: 1 }];
  const days = byDay(events, "Indian/Mauritius");
  assert.deepEqual(days.map((d) => d.day), ["2026-10-10", "2026-10-09"]);
  assert.deepEqual(days.map((d) => d.events.map((e) => e.n)), [[3], [2, 1]]);
  assert.deepEqual(byDay([], "Indian/Mauritius"), []);
  // the same events are one day in UTC
  assert.equal(byDay(events, "UTC").length, 1);
});

const move = (dir, amount, more = {}) => ({ at: "2026-10-09T05:00:00Z", dir, who: "Asha", method: "Cash", ref: null, amount: String(amount), type: "Sale", comment: null, ...more });

check("payments in and out are told apart, each with its total", () => {
  const out = splitMoves([move("in", 5000), move("out", 7000, { type: "Cash out", comment: "Ice" }), move("in", 20000, { type: "Cash in" }), move("out", 5000, { type: "Refund" })]);
  assert.equal(out.inflows.length, 2);
  assert.equal(out.outflows.length, 2);
  assert.equal(out.inTotal, 25000);
  assert.equal(out.outTotal, 12000);
  assert.deepEqual(splitMoves([]), { inflows: [], outflows: [], inTotal: 0, outTotal: 0 });
});

const m = (v) => "Rs " + (Number(v ?? 0) / 100).toFixed(2);
const ev = (kind, more = {}) => ({ at: "2026-10-09T05:00:00Z", kind, device_id: TILL, till: "Counter", code: "T1", who: "Asha", ref: null, words: null, amount: null, extra: null, late: null, total: 1, ...more });

check("an event says what it was", () => {
  assert.equal(eventDetail(ev("sale", { ref: "PP-1", amount: "5000" }), m), "PP-1 · Rs 50.00");
  assert.equal(eventDetail(ev("refund", { ref: "PP-R4", amount: "5000" }), m), "PP-R4 · -Rs 50.00");
  assert.equal(eventDetail(ev("cash_in", { words: "Change from the bank", amount: "20000" }), m), "Rs 200.00 · Change from the bank");
  assert.equal(eventDetail(ev("cash_out", { words: "Ice", amount: "7000" }), m), "-Rs 70.00 · Ice");
  assert.equal(eventDetail(ev("cash_out", { amount: "7000" }), m), "-Rs 70.00");
  assert.equal(eventDetail(ev("cash_drawer"), m), "With no sale");
  assert.equal(eventDetail(ev("open", { amount: "100000" }), m), "Opening float Rs 1000.00");
  assert.equal(eventDetail(ev("clock_in"), m), "");
});

check("a count and a closing say what was counted, what was expected, and by how much they differ", () => {
  assert.equal(eventDetail(ev("count", { amount: "117000", extra: "118000" }), m), "Counted Rs 1170.00, expected Rs 1180.00, short by Rs 10.00");
  assert.equal(eventDetail(ev("count", { amount: "118000", extra: "118000" }), m), "Counted Rs 1180.00, expected Rs 1180.00, balanced");
  assert.equal(eventDetail(ev("close", { ref: "12", amount: "118500", extra: "118000" }), m), "Day closing no. 12. Counted Rs 1185.00, expected Rs 1180.00, over by Rs 5.00");
  assert.equal(eventDetail(ev("close", { ref: "12" }), m), "Day closing no. 12");
  assert.equal(eventDetail(ev("crash", { ref: "0.6.3 (10)", words: "java.lang.SecurityException" }), m), "java.lang.SecurityException (version 0.6.3 (10))");
});

// ---- what the back office asks of a till (migration 0091) ----
const asked = (more = {}) => ({ id: "r1", device_id: TILL, shift_id: "s1", kind: "close_day", counted_cash: null, amount: null, reason: null, status: "waiting", note: null,
  requested_at: "2026-10-09T19:10:00Z", answered_at: null, who: "Mira", ...more });

check("a till takes requests from build 12 on, and one that never said its build does not", () => {
  assert.equal(REQUEST_BUILD, 12);
  assert.equal(takesRequests({ till_version: 12, off: false }), true);
  assert.equal(takesRequests({ till_version: 13, off: false }), true);
  assert.equal(takesRequests({ till_version: 11, off: false }), false);
  assert.equal(takesRequests({ till_version: null, off: false }), false);
  assert.equal(takesRequests({ till_version: 12, off: true }), false);
});

check("a request says what was asked", () => {
  assert.equal(askSays(asked(), m), "Close the day at what the till expects");
  assert.equal(askSays(asked({ counted_cash: "117000" }), m), "Close the day, counted Rs 1170.00");
  assert.equal(askSays(asked({ kind: "cash_out", amount: "7000", reason: "Ice" }), m), "Take Rs 70.00 out · Ice");
});

check("and how it ended", () => {
  assert.deepEqual(askEnded(asked()), ["Waiting for the till to sync", "amber"]);
  assert.deepEqual(askEnded(asked({ status: "done" })), ["Done", "green"]);
  assert.deepEqual(askEnded(asked({ status: "cancelled" })), ["Cancelled", ""]);
  assert.deepEqual(askEnded(asked({ status: "refused", note: "That day is no longer open on the till." })), ["Refused: That day is no longer open on the till.", "red"]);
  assert.deepEqual(askEnded(asked({ status: "refused" })), ["Refused by the till", "red"]);
});

check("what the database refuses is put into words", () => {
  assert.equal(refusal("till-too-old"), "This till's build does not take requests from the back office. Update the till first.");
  assert.equal(refusal("no-day-open"), "This till has no day open, as far as it has synced.");
  assert.equal(refusal("already-asked"), "A closing is already waiting for this till.");
  assert.equal(refusal("forbidden"), "Your role does not include doing this on a till.");
  assert.equal(refusal("not-waiting"), "The till has already answered it, or it was cancelled.");
  assert.equal(refusal("reason-required"), "Say what the cash is for.");
  assert.equal(refusal("bad-amount"), "Type an amount above nothing.");
  // anything else is not shown as it came
  assert.equal(refusal("relation \"x\" does not exist"), "That could not be asked. Nothing was changed.");
  assert.equal(refusal(undefined), "That could not be asked. Nothing was changed.");
});

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
