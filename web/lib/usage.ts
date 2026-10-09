// What the admin area's Usage page works out from the rows it reads
// (migration 0090): Neon's totals as the hourly job read them, and which five
// minutes each client was active in.
//
// Neon meters a project and each of its branches, never a client. So what a
// client used is an estimate, made here: Neon puts a compute to sleep after
// five idle minutes, a client active in a five-minute slot is taken to have
// kept production awake for it, and a slot several clients were active in is
// split equally between them.

const SLOT_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TZ = "Indian/Mauritius";

// What each Neon plan allows a project in a period, in compute hours. Neon's
// API names the plan and not its allowance, so the figure is kept here: a plan
// that is not listed shows what was used and no "left".
export const ALLOWANCE: Record<string, number> = { free_v3: 100 };
// The size every compute is capped at (set 2026-10-08): the compute hours an
// hour awake costs, for when there is no reading to take the ratio from.
export const CAPPED_SIZE = 0.25;
// The job reads every hour while production is awake, so a reading older than
// this means it has stopped, not that the database slept through a night.
const STALE_MS = 26 * HOUR_MS;

export type Mark = { tenant_id: string; hour: string; slots: number };
export type Branch = { name: string; default?: boolean; compute_seconds: number; active_seconds: number; logical_size?: number };
export type Reading = {
  project_id: string;
  day: string;
  read_at: string;
  period_start: string;
  period_end: string | null;
  plan: string | null;
  compute_seconds: number;
  active_seconds: number;
  storage_limit_bytes: number | null;
  branches_limit: number | null;
  branches: Branch[];
};

// when each slot a mark names began
function slotTimes(mark: Mark): number[] {
  const hour = Date.parse(mark.hour);
  const out: number[] = [];
  for (let s = 0; s < 12; s++) if (mark.slots & (1 << s)) out.push(hour + s * SLOT_MS);
  return out;
}

export type Split = { clients: Map<string, { share: number; alone: number }>; other: number | null };

// Each client's part of production's compute hours, and what it would have
// used with a database to itself. `rate` is the compute hours an hour awake
// costs. `measured` is what Neon says production used: what is left of it
// after the shares is nobody's, and shares that add up to more are scaled
// down to it. Without it there is nothing to measure against.
export function split(marks: Mark[], opts: { from: number; to: number; rate: number; measured?: number }): Split {
  const bySlot = new Map<number, string[]>();
  for (const mark of marks) {
    for (const t of slotTimes(mark)) {
      if (t < opts.from || t >= opts.to) continue;
      const who = bySlot.get(t);
      if (!who) bySlot.set(t, [mark.tenant_id]);
      else if (!who.includes(mark.tenant_id)) who.push(mark.tenant_id);
    }
  }
  const slotHours = (SLOT_MS / HOUR_MS) * opts.rate;
  const clients = new Map<string, { share: number; alone: number }>();
  for (const who of bySlot.values()) {
    for (const id of who) {
      const c = clients.get(id) ?? { share: 0, alone: 0 };
      c.share += slotHours / who.length;
      c.alone += slotHours;
      clients.set(id, c);
    }
  }
  if (opts.measured === undefined) return { clients, other: null };
  let shared = 0;
  for (const c of clients.values()) shared += c.share;
  if (shared > opts.measured && shared > 0) {
    const down = opts.measured / shared;
    for (const c of clients.values()) c.share *= down;
    return { clients, other: 0 };
  }
  return { clients, other: opts.measured - shared };
}

export type Pace = { early: true } | { early: false; projected: number; runsOut: string | null };

// Where the period is heading: what was used so far, carried at the same pace
// to its end. Not said before the period is three days old, when one busy
// afternoon would speak for a month. `runsOut` is the day the allowance would
// be reached, when that is before the period ends.
export function pace(r: Pick<Reading, "period_start" | "period_end" | "read_at" | "compute_seconds">, allowance: number | null): Pace {
  const start = Date.parse(r.period_start);
  const elapsed = Date.parse(r.read_at) - start;
  if (!r.period_end || elapsed < 3 * DAY_MS) return { early: true };
  const used = r.compute_seconds / 3600;
  const projected = (used * (Date.parse(r.period_end) - start)) / elapsed;
  const runsOut = allowance !== null && used > 0 && projected > allowance ? new Date(start + (elapsed * allowance) / used).toISOString() : null;
  return { early: false, projected, runsOut };
}

export type DayRow = { day: string; used: number; production: number; sinceStart: boolean };

const mainOf = (r: Reading) => r.branches.find((b) => b.default) ?? null;

// Day by day, newest first: a day's use is its reading less the day before's.
// The first reading of a period holds everything since the period began, and
// says so. In compute hours.
export function days(readings: Reading[]): DayRow[] {
  const sorted = [...readings].sort((a, b) => (a.day < b.day ? -1 : 1));
  const out: DayRow[] = [];
  sorted.forEach((r, i) => {
    const before = i > 0 && sorted[i - 1].period_start === r.period_start ? sorted[i - 1] : null;
    const less = (now: number, was: number | undefined) => Math.max(0, now - (was ?? 0)) / 3600;
    out.push({
      day: r.day,
      used: less(r.compute_seconds, before?.compute_seconds),
      production: less(mainOf(r)?.compute_seconds ?? 0, before ? mainOf(before)?.compute_seconds : undefined),
      sinceStart: before === null,
    });
  });
  return out.reverse();
}

const localParts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function local(t: number): { day: string; hour: number } {
  const p = Object.fromEntries(localParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// The hours of the day (in Mauritius) a client is usually active in, over the
// last fourteen days: those it was active in on at least half of its active
// days, from the first to the last. `to` is the hour it ends at, and is the
// smaller of the two for a client open past midnight. Null under three active
// days: too early to say.
export function usualHours(marks: Mark[], tenantId: string, now: number): { from: number; to: number } | null {
  const daysByHour = new Map<number, Set<string>>();
  const activeDays = new Set<string>();
  for (const mark of marks) {
    if (mark.tenant_id !== tenantId || mark.slots === 0) continue;
    const t = Date.parse(mark.hour);
    if (t < now - 14 * DAY_MS || t > now) continue;
    const at = local(t);
    activeDays.add(at.day);
    daysByHour.set(at.hour, (daysByHour.get(at.hour) ?? new Set()).add(at.day));
  }
  if (activeDays.size < 3) return null;
  const usual = [...daysByHour].filter(([, d]) => d.size * 2 >= activeDays.size).map(([h]) => h).sort((a, b) => a - b);
  if (usual.length === 0) return null;
  // the day is a circle: the span starts after the longest stretch with no usual hour
  let start = usual[0];
  let gap = usual[0] + 24 - usual[usual.length - 1];
  for (let i = 1; i < usual.length; i++) {
    if (usual[i] - usual[i - 1] > gap) {
      gap = usual[i] - usual[i - 1];
      start = usual[i];
    }
  }
  const last = usual[(usual.indexOf(start) + usual.length - 1) % usual.length];
  return { from: start, to: (last + 1) % 24 };
}

export type ClientUse = { id: string; name: string; share: number; alone: number; usual: { from: number; to: number } | null; bytes: number };
export type UsageModel = {
  reading: Reading | null;
  stale: boolean;
  allowance: number | null;
  used: number | null;
  left: number | null;
  // the branches that used any compute, production first
  branches: { name: string; main: boolean; hours: number }[];
  pace: Pace | null;
  days: DayRow[];
  clients: ClientUse[];
  other: { share: number | null; bytes: number };
  countingSince: string | null;
  storage: { bytes: number; limit: number | null; branches: number | null; branchesLimit: number | null; names: string[] };
};

// Everything the page shows, from the rows it read. `dbBytes` is the size of
// the database the page itself is connected to.
export function usageModel(input: {
  readings: Reading[];
  marks: Mark[];
  tenants: { id: string; name: string }[];
  storage: { tenant_id: string; bytes: number }[];
  dbBytes: number;
  now: number;
}): UsageModel {
  const newest = [...input.readings].sort((a, b) => Date.parse(b.read_at) - Date.parse(a.read_at))[0] ?? null;
  const mine = newest ? input.readings.filter((r) => r.project_id === newest.project_id) : [];
  const main = newest ? mainOf(newest) : null;
  const allowance = newest?.plan ? (ALLOWANCE[newest.plan] ?? null) : null;
  const used = newest ? newest.compute_seconds / 3600 : null;

  const parts = split(
    input.marks,
    newest && main
      ? {
          from: Date.parse(newest.period_start),
          to: Date.parse(newest.read_at),
          rate: main.active_seconds > 0 ? main.compute_seconds / main.active_seconds : CAPPED_SIZE,
          measured: main.compute_seconds / 3600,
        }
      : { from: 0, to: input.now, rate: CAPPED_SIZE },
  );
  const bytesOf = new Map(input.storage.map((s) => [s.tenant_id, s.bytes]));
  const clients = input.tenants
    .map((t) => ({
      id: t.id,
      name: t.name,
      share: parts.clients.get(t.id)?.share ?? 0,
      alone: parts.clients.get(t.id)?.alone ?? 0,
      usual: usualHours(input.marks, t.id, input.now),
      bytes: bytesOf.get(t.id) ?? 0,
    }))
    .sort((a, b) => b.share - a.share || b.bytes - a.bytes || a.name.localeCompare(b.name));
  const clientBytes = clients.reduce((sum, c) => sum + c.bytes, 0);
  const first = input.marks.reduce<number | null>((min, m) => (m.slots === 0 ? min : Math.min(min ?? Infinity, Date.parse(m.hour))), null);

  return {
    reading: newest,
    stale: newest !== null && input.now - Date.parse(newest.read_at) > STALE_MS,
    allowance,
    used,
    left: allowance !== null && used !== null ? Math.max(0, allowance - used) : null,
    branches: newest
      ? newest.branches
          .filter((b) => b.default || b.compute_seconds > 0)
          .map((b) => ({ name: b.name, main: b.default === true, hours: b.compute_seconds / 3600 }))
          .sort((a, b) => Number(b.main) - Number(a.main) || b.hours - a.hours)
      : [],
    pace: newest ? pace(newest, allowance) : null,
    days: days(mine),
    clients,
    other: { share: parts.other, bytes: Math.max(0, input.dbBytes - clientBytes) },
    countingSince: first === null ? null : new Date(first).toISOString(),
    storage: {
      bytes: input.dbBytes,
      limit: newest?.storage_limit_bytes ?? null,
      branches: newest ? newest.branches.length : null,
      branchesLimit: newest?.branches_limit ?? null,
      names: newest ? newest.branches.map((b) => b.name) : [],
    },
  };
}
