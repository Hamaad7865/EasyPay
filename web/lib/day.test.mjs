// day.test.mjs — a day read from an address (?from=2026-10-08) is only taken
// when it is a day of the calendar (web/lib/day.ts). The database refuses
// anything else, and a page that passed it on stopped with an error.
// Usage: node web/lib/day.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { isDay } from "./day.ts";

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

check("a day of the calendar is a day", () => {
  for (const d of ["2026-10-08", "2026-01-01", "2026-12-31", "2028-02-29", "2000-02-29"]) assert.ok(isDay(d), d);
});
check("a day no calendar has is not: the month 99, the 30th of February, a 29th of February in a common year", () => {
  for (const d of ["2026-99-99", "2026-13-01", "2026-00-10", "2026-02-30", "2026-02-29", "2026-04-31", "2026-10-00", "2026-10-32", "1900-02-29", "0000-01-01"]) assert.ok(!isDay(d), d);
});
check("anything that is not written year-month-day is not", () => {
  for (const d of ["", "garbage", "2026-10-8", "26-10-08", "2026/10/08", "08-10-2026", " 2026-10-08", "2026-10-08 ", "2026-10-08T00:00:00Z", "0000-00-00"]) assert.ok(!isDay(d), JSON.stringify(d));
});
check("what is not text is not a day either: nothing, a number, a list", () => {
  for (const d of [undefined, null, 20261008, ["2026-10-08"], {}]) assert.ok(!isDay(d), JSON.stringify(d));
});

console.log(failures === 0 ? "DAY PASS" : `DAY FAIL (${failures})`);
process.exit(failures ? 1 : 0);
