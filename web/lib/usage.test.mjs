// usage.test.mjs — what the admin area's Usage page works out (web/lib/usage.ts).
// Usage: node web/lib/usage.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { days, pace, split, usageModel, usualHours } from "./usage.ts";

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
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what ?? "value"}: ${a}, expected ${b}`);
const at = (iso) => Date.parse(iso);
// a client's hour: the five-minute slots it was active in, by their number (0 is minutes 0 to 4)
const mark = (tenant, hour, ...slots) => ({ tenant_id: tenant, hour, slots: slots.reduce((m, s) => m | (1 << s), 0) });
const WIDE = { from: 0, to: at("2030-01-01T00:00:00Z"), rate: 0.25 };

check("a client alone: each slot is five minutes awake, at the compute's size", () => {
  const out = split([mark("a", "2026-03-04T10:00:00Z", 0, 3, 6)], WIDE);
  near(out.clients.get("a").alone, (15 / 60) * 0.25, "by itself");
  near(out.clients.get("a").share, (15 / 60) * 0.25, "share");
  assert.equal(out.other, null);
});

check("a slot two clients were active in is split between them", () => {
  const out = split([mark("a", "2026-03-04T10:00:00Z", 0, 1), mark("b", "2026-03-04T10:00:00Z", 1, 2)], WIDE);
  near(out.clients.get("a").share, (7.5 / 60) * 0.25, "a's share");
  near(out.clients.get("b").share, (7.5 / 60) * 0.25, "b's share");
  near(out.clients.get("a").alone, (10 / 60) * 0.25, "a by itself");
});

check("what Neon measured beyond the clients' shares is nobody's", () => {
  const out = split([mark("a", "2026-03-04T10:00:00Z", 0, 1), mark("b", "2026-03-04T10:00:00Z", 1, 2)], { ...WIDE, measured: 0.1 });
  near(out.other, 0.1 - (15 / 60) * 0.25, "not a client's");
  near(out.clients.get("a").share, (7.5 / 60) * 0.25, "a's share is left as it was");
});

check("shares that add up to more than Neon measured are scaled down to it", () => {
  const out = split([mark("a", "2026-03-04T10:00:00Z", 0, 1), mark("b", "2026-03-04T10:00:00Z", 1, 2)], { ...WIDE, measured: 0.05 });
  near(out.clients.get("a").share + out.clients.get("b").share, 0.05, "together");
  near(out.other, 0, "not a client's");
  near(out.clients.get("a").alone, (10 / 60) * 0.25, "by itself is not scaled");
});

check("only the slots from the period's start up to the reading are counted", () => {
  const marks = [mark("a", "2026-03-04T10:00:00Z", 0, 6, 11)];
  const out = split(marks, { from: at("2026-03-04T10:30:00Z"), to: at("2026-03-04T10:55:00Z"), rate: 0.25 });
  near(out.clients.get("a").alone, (5 / 60) * 0.25, "only half past ten");
  assert.equal(split(marks, { from: at("2026-03-04T11:00:00Z"), to: WIDE.to, rate: 0.25 }).clients.has("a"), false);
});

const period = { period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z" };

check("where the period is heading is not said before it is three days old", () => {
  assert.deepEqual(pace({ ...period, read_at: "2026-03-03T23:00:00Z", compute_seconds: 3600 }, 100), { early: true });
});

check("used so far, carried at the same pace to the period's end", () => {
  const p = pace({ ...period, read_at: "2026-03-11T00:00:00Z", compute_seconds: 20 * 3600 }, 100);
  assert.equal(p.early, false);
  near(p.projected, 62, "by the end");
  assert.equal(p.runsOut, null);
});

check("a pace that passes the allowance names the day it runs out", () => {
  const p = pace({ ...period, read_at: "2026-03-11T00:00:00Z", compute_seconds: 50 * 3600 }, 100);
  near(p.projected, 155, "by the end");
  assert.equal(p.runsOut, "2026-03-21T00:00:00.000Z");
  // a plan whose allowance is not known has no such day
  assert.equal(pace({ ...period, read_at: "2026-03-11T00:00:00Z", compute_seconds: 50 * 3600 }, null).runsOut, null);
});

const reading = (day, compute, production, more = {}) => ({
  project_id: "p1", day, read_at: day + "T12:00:00Z", ...period, plan: "free_v3", compute_seconds: compute, active_seconds: compute * 4,
  storage_limit_bytes: 1000, branches_limit: 10,
  branches: [
    { name: "production", default: true, compute_seconds: production, active_seconds: production * 4, logical_size: 600 },
    { name: "dev-review", default: false, compute_seconds: compute - production, active_seconds: (compute - production) * 4, logical_size: 700 },
  ],
  ...more,
});

check("a day's use is its reading less the day before's, newest first", () => {
  const out = days([reading("2026-03-04", 3600, 1800), reading("2026-03-05", 10800, 3600)]);
  assert.deepEqual(out.map((d) => d.day), ["2026-03-05", "2026-03-04"]);
  near(out[0].used, 2, "the 5th");
  near(out[0].production, 0.5, "production on the 5th");
  assert.equal(out[0].sinceStart, false);
  // the first reading of a period holds everything since it began
  near(out[1].used, 1, "the 4th");
  assert.equal(out[1].sinceStart, true);
});

check("a new period starts from its own figure, and a figure that fell is no use at all", () => {
  const next = { period_start: "2026-04-01T00:00:00Z", period_end: "2026-05-01T00:00:00Z" };
  const out = days([reading("2026-03-31", 36000, 18000), reading("2026-04-01", 720, 360, next), reading("2026-04-02", 700, 360, next)]);
  near(out[1].used, 0.2, "the 1st of the new period");
  assert.equal(out[1].sinceStart, true);
  near(out[0].used, 0, "never less than nothing");
});

// Mauritius is four hours ahead of UTC: 05:00 UTC is 09:00 there
const NOW = at("2026-03-10T12:00:00Z");
const open = (tenant, day, fromUtc, toUtc) =>
  Array.from({ length: toUtc - fromUtc }, (_, i) => mark(tenant, `${day}T${String(fromUtc + i).padStart(2, "0")}:00:00Z`, 0));

check("the hours a client is usually active in, in Mauritius", () => {
  const marks = ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"].flatMap((d) => open("a", d, 5, 17));
  // one late night does not make it usual
  marks.push(mark("a", "2026-03-08T19:00:00Z", 0));
  assert.deepEqual(usualHours(marks, "a", NOW), { from: 9, to: 21 });
});

check("under three days of it is too early to say, and older than fourteen days is not looked at", () => {
  assert.equal(usualHours([...open("a", "2026-03-08", 5, 17), ...open("a", "2026-03-09", 5, 17)], "a", NOW), null);
  const old = ["2026-02-01", "2026-02-02", "2026-02-03"].flatMap((d) => open("a", d, 5, 17));
  assert.equal(usualHours(old, "a", NOW), null);
});

check("a client open past midnight starts in the evening", () => {
  const marks = ["2026-03-06", "2026-03-07", "2026-03-08"].flatMap((d) => open("a", d, 14, 22));
  assert.deepEqual(usualHours(marks, "a", NOW), { from: 18, to: 2 });
});

const tenants = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "c", name: "Quiet" }];
const storage = [{ tenant_id: "a", bytes: 300 }, { tenant_id: "b", bytes: 100 }];

check("the page with a reading: used, left, the branches, the clients and what is nobody's", () => {
  const marks = [mark("a", "2026-03-05T10:00:00Z", 0, 1, 2), mark("b", "2026-03-05T10:00:00Z", 2)];
  const m = usageModel({
    readings: [reading("2026-03-04", 3600, 1800), reading("2026-03-05", 10800, 3600)],
    marks, tenants, storage, dbBytes: 600, now: at("2026-03-05T13:00:00Z"),
  });
  assert.equal(m.reading.day, "2026-03-05");
  assert.equal(m.stale, false);
  assert.equal(m.allowance, 100);
  near(m.used, 3, "used");
  near(m.left, 97, "left");
  assert.deepEqual(m.branches.map((b) => [b.name, b.main]), [["production", true], ["dev-review", false]]);
  near(m.branches[0].hours, 1, "production");
  assert.deepEqual(m.clients.map((c) => c.name), ["Alpha", "Beta", "Quiet"]);
  // production ran at a quarter of a compute hour an hour awake: 12.5 and 2.5 minutes of it
  near(m.clients[0].share, (12.5 / 60) * 0.25, "Alpha's share");
  near(m.clients[1].share, (2.5 / 60) * 0.25, "Beta's share");
  near(m.clients[2].share, 0, "a client that was never active");
  assert.equal(m.clients[0].bytes, 300);
  assert.equal(m.clients[2].bytes, 0);
  near(m.other.share, 1 - (15 / 60) * 0.25, "not a client's");
  assert.equal(m.other.bytes, 200);
  assert.deepEqual(m.storage, { bytes: 600, limit: 1000, branches: 2, branchesLimit: 10, names: ["production", "dev-review"] });
  assert.equal(m.countingSince, "2026-03-05T10:00:00.000Z");
  assert.equal(m.days.length, 2);
});

check("a reading more than a day old is flagged, and a plan the page does not know has no allowance", () => {
  const m = usageModel({ readings: [reading("2026-03-05", 10800, 3600, { plan: "launch" })], marks: [], tenants, storage, dbBytes: 600, now: at("2026-03-07T00:00:00Z") });
  assert.equal(m.stale, true);
  assert.equal(m.allowance, null);
  assert.equal(m.left, null);
});

check("the page before any reading: the clients by the slots alone, nothing of Neon's", () => {
  const m = usageModel({ readings: [], marks: [mark("a", "2026-03-05T10:00:00Z", 0, 1)], tenants, storage, dbBytes: 600, now: at("2026-03-05T13:00:00Z") });
  assert.equal(m.reading, null);
  assert.equal(m.used, null);
  near(m.clients[0].share, (10 / 60) * 0.25, "Alpha's share at the size every compute is capped at");
  assert.equal(m.other.share, null);
  assert.equal(m.other.bytes, 200);
  assert.deepEqual(m.storage, { bytes: 600, limit: null, branches: null, branchesLimit: null, names: [] });
});

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
