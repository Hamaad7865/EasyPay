// A day as an address or a form writes it: 2026-10-08. It has to be a day of
// the calendar and not only look like one: the database refuses 2026-99-99
// and the 30th of February, and a page that passed one on stopped with an
// error. Pure, so `node web/lib/day.test.mjs` can ask it.
const SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s: unknown): s is string {
  // the database's calendar starts at year 1
  if (typeof s !== "string" || !SHAPE.test(s) || s < "0001-01-01") return false;
  const d = new Date(s + "T00:00:00Z");
  // a date that does not exist is either no date at all, or rolls into the next month
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
