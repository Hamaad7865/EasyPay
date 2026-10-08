// What the Point of sale pages share: how a till's last sync reads, and the
// queries the pages are drawn from.
//
// The back office knows when a till last synced, not whether it is connected
// this second. A till sends each sale as it is made, and while someone is at
// it checks in about every 15 minutes. Left untouched for half an hour it
// stops asking, and syncs again at the next touch: the database is paid for
// by the hour it is awake, and a till asking for news all night kept it
// awake for nothing. So a till that says nothing is a till no one is at, or a
// tablet that is off, and nothing here can tell the two apart. Neither is
// called a fault. The wording below never claims more than that.

export type TillState = "off" | "never" | "ok" | "idle";

export const FRESH_MINUTES = 30; // a till in use checks in twice in this time

// off     the till was deactivated
// never   it has not synced since it was set up
// ok      it synced in the last half hour: someone is at it
// idle    it has said nothing for longer: no one is at it, or the tablet is off
export function tillState(seen: Date | null, now: Date, deactivated: boolean): TillState {
  if (deactivated) return "off";
  if (!seen) return "never";
  return (now.getTime() - seen.getTime()) / 60000 <= FRESH_MINUTES ? "ok" : "idle";
}

// How long ago, the way someone would say it.
export function ago(at: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h ago` : `${h} h ${m % 60} min ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// A length of time: "40 s", "12 min", "3 h 05 min", "2 days".
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} days`;
}

// A sale is sent as it is made. One that reached the server more than this
// long after the till rang it up was made while the till was offline (or the
// tablet's clock is wrong).
export const LATE_SECONDS = 120;
export const isLate = (seconds: number | null) => seconds !== null && seconds > LATE_SECONDS;

export const STATE_BADGE: Record<TillState, string> = { off: "", never: "", ok: "green", idle: "" };

export function stateLine(state: TillState, seen: Date | null, now: Date): string {
  switch (state) {
    case "off": return "Deactivated";
    case "never": return "Not synced yet";
    case "ok": return `Synced ${ago(seen!, now)}`;
    case "idle": return `Last synced ${ago(seen!, now)}`;
  }
}

// ---- queries ----

// A till's receipts and cash movements inside one of its days (a shift: from
// the opening count to the closing count, or to now while it is open). The
// same window Day closing uses for a day that is still open.
export const IN_SHIFT = (row: string, sh = "sh") =>
  `${row}.tenant_id = ${sh}.tenant_id and ${row}.device_id = ${sh}.device_id and ${row}.deleted_at is null
   and coalesce(${row}.device_time, ${row}.created_at) >= ${sh}.opened_at
   and coalesce(${row}.device_time, ${row}.created_at) <= coalesce(${sh}.closed_at, now())`;

// The cash a shift took: its cash payments, with cash refunds taken off.
// A payment whose type was corrected counts as what it was corrected to.
const CASH_TAKEN = (sh = "sh") => `
  coalesce((select sum(case when r.type = 'refund' then -p.amount else p.amount end)
     from receipts r
     join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
     join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind = 'cash'
    where ${IN_SHIFT("r", sh)}), 0)`;
const MOVED = (type: string, sh = "sh") => `
  coalesce((select sum(m.amount) from cash_movements m where ${IN_SHIFT("m", sh)} and m.type::text = '${type}'), 0)`;

// Every till, with when it was last heard from, the day open on it, and what
// it has done today. $1 tenant, $2 today's date in the store's timezone.
// A till set up before the server kept sync times has none yet: the last
// thing it sent (a receipt arriving) or its set-up stands in until it syncs.
export const TILLS = `
  select d.id, d.name, d.code, d.app_version, d.created_at, d.deleted_at is not null as off,
         s.name as store, s.timezone,
         a.last_seen_at as synced, a.last_push_at, a.last_pull_at, a.till_version,
         coalesce(a.last_seen_at, greatest(d.last_seen_at, lr.last_in)) as seen,
         a.last_seen_at is null as before_times,
         sh.id as shift_id, sh.opened_at, ob.name as opened_by, sh.opening_float,
         case when sh.id is null then null else ${CASH_TAKEN()} end as cash_taken,
         case when sh.id is null then null else ${MOVED("in")} end as cash_in,
         case when sh.id is null then null else ${MOVED("out")} end as cash_out,
         lc.closed_at as last_closed_at, lc.number as last_close_no,
         t.sales, t.refunds, t.gross, t.refunded, t.late, t.worst_late,
         l.number as last_number, l.at as last_at, l.type as last_type, l.total as last_total,
         (select count(*)::int from crash_reports c where c.tenant_id = d.tenant_id and c.device_id = d.id and c.deleted_at is null
            and c.happened_at > now() - interval '7 days') as crashes
    from pos_devices d
    join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
    left join device_activity a on a.tenant_id = d.tenant_id and a.device_id = d.id
    left join lateral (select max(r.created_at) as last_in from receipts r where r.tenant_id = d.tenant_id and r.device_id = d.id) lr on true
    left join lateral (select x.* from shifts x where x.tenant_id = d.tenant_id and x.device_id = d.id and x.deleted_at is null and x.closed_at is null
                        order by x.opened_at desc limit 1) sh on true
    left join employees ob on ob.tenant_id = d.tenant_id and ob.id = sh.opened_by
    left join lateral (select dc.closed_at, dc.number from day_closes dc where dc.tenant_id = d.tenant_id and dc.device_id = d.id and dc.deleted_at is null
                        order by dc.closed_at desc limit 1) lc on true
    left join lateral (
      select count(*) filter (where r.type = 'sale')::int as sales, count(*) filter (where r.type = 'refund')::int as refunds,
             coalesce(sum(r.total) filter (where r.type = 'sale'), 0) as gross, coalesce(sum(r.total) filter (where r.type = 'refund'), 0) as refunded,
             count(*) filter (where r.device_time is not null and r.created_at - r.device_time > interval '${LATE_SECONDS} seconds')::int as late,
             coalesce(extract(epoch from max(r.created_at - r.device_time)), 0)::int as worst_late
        from receipts r
       where r.tenant_id = d.tenant_id and r.device_id = d.id and r.deleted_at is null
         and (coalesce(r.device_time, r.created_at) at time zone s.timezone)::date = $2::date) t on true
    left join lateral (
      select r.number, coalesce(r.device_time, r.created_at) as at, r.type, r.total
        from receipts r where r.tenant_id = d.tenant_id and r.device_id = d.id and r.deleted_at is null
       order by coalesce(r.device_time, r.created_at) desc limit 1) l on true
   where d.tenant_id = $1
   order by d.deleted_at is not null, s.name, d.code, d.name`;

export type Till = {
  id: string; name: string; code: string; app_version: string | null; created_at: string; off: boolean;
  store: string; timezone: string;
  synced: string | null; last_push_at: string | null; last_pull_at: string | null; till_version: number | null;
  seen: string | null; before_times: boolean;
  shift_id: string | null; opened_at: string | null; opened_by: string | null; opening_float: string | null;
  cash_taken: string | null; cash_in: string | null; cash_out: string | null;
  last_closed_at: string | null; last_close_no: number | null;
  sales: number; refunds: number; gross: string; refunded: string; late: number; worst_late: number;
  last_number: string | null; last_at: string | null; last_type: string | null; last_total: string | null;
  crashes: number;
};

// What a drawer should hold: its float, the cash it took, what was put in, less what was taken out.
export const expectedCash = (float: unknown, taken: unknown, cashIn: unknown, cashOut: unknown) =>
  Number(float ?? 0) + Number(taken ?? 0) + Number(cashIn ?? 0) - Number(cashOut ?? 0);

// What a till did on one day, newest first: its day opened and closed, each
// sale and refund, cash put in and taken out, the drawer opened with no sale
// and counted, people clocking in and out on it, and the app stopping
// unexpectedly. `late` is how many seconds after the till wrote it down the
// server had it: a sale made offline shows here. $1 tenant, $2 the day,
// $3 a till or null for all of them, $4 how many at most, $5 the timezone
// the day is in.
export const ACTIVITY = `
  with ev as (
    select coalesce(r.device_time, r.created_at) as at, r.type::text as kind, r.device_id, r.employee_id,
           r.number::text as ref, null::text as words, r.total::bigint as amount, null::bigint as extra,
           extract(epoch from r.created_at - r.device_time)::int as late
      from receipts r where r.tenant_id = $1 and r.deleted_at is null
    union all
    select coalesce(m.device_time, m.created_at), 'cash_' || m.type::text, m.device_id, m.employee_id,
           null, m.reason, case when m.type::text = 'drawer' then null else m.amount end, null,
           extract(epoch from m.created_at - m.device_time)::int
      from cash_movements m where m.tenant_id = $1 and m.deleted_at is null
    union all
    select coalesce(x.device_time, x.created_at), 'count', x.device_id, x.employee_id,
           null, null, x.counted, x.expected, extract(epoch from x.created_at - x.device_time)::int
      from drawer_counts x where x.tenant_id = $1 and x.deleted_at is null
    union all
    select sh.opened_at, 'open', sh.device_id, sh.opened_by, null, null, sh.opening_float, null,
           extract(epoch from sh.created_at - sh.opened_at)::int
      from shifts sh where sh.tenant_id = $1 and sh.deleted_at is null
    union all
    select dc.closed_at, 'close', dc.device_id, dc.closed_by, dc.number::text, null, sh.counted_cash, sh.expected_cash,
           extract(epoch from dc.created_at - dc.closed_at)::int
      from day_closes dc
      left join shifts sh on sh.tenant_id = dc.tenant_id and sh.device_id = dc.device_id and sh.closed_at = dc.closed_at and sh.deleted_at is null
     where dc.tenant_id = $1 and dc.deleted_at is null
    union all
    select coalesce(p.device_time, p.created_at), 'clock_' || p.kind::text, p.device_id, p.employee_id, null, null, null, null,
           extract(epoch from p.created_at - p.device_time)::int
      from timeclock_punches p where p.tenant_id = $1 and p.deleted_at is null
    union all
    select c.happened_at, 'crash', c.device_id, c.employee_id, c.app_version, c.summary, null, null, null
      from crash_reports c where c.tenant_id = $1 and c.deleted_at is null and c.device_id is not null
  )
  select ev.at, ev.kind, ev.device_id, d.name as till, d.code, e.name as who, ev.ref, ev.words, ev.amount, ev.extra, ev.late,
         count(*) over ()::int as total
    from ev
    left join pos_devices d on d.tenant_id = $1 and d.id = ev.device_id
    left join employees e on e.tenant_id = $1 and e.id = ev.employee_id
   where ev.at >= ($2::date::timestamp at time zone $5::text)
     and ev.at < (($2::date + 1)::timestamp at time zone $5::text)
     and ($3::uuid is null or ev.device_id = $3::uuid)
   order by ev.at desc
   limit $4`;

export type Event = {
  at: string; kind: string; device_id: string | null; till: string | null; code: string | null; who: string | null;
  ref: string | null; words: string | null; amount: string | null; extra: string | null; late: number | null; total: number;
};

// The days (shifts) of a till, newest first, for the cash flow's "which day".
// $1 tenant, $2 the till.
export const SHIFTS = `
  select sh.id, sh.opened_at, sh.closed_at
    from shifts sh where sh.tenant_id = $1 and sh.device_id = $2 and sh.deleted_at is null
   order by sh.opened_at desc limit 60`;

// One day on a till, as its drawer saw it. $1 tenant, $2 the shift.
export const SHIFT = `
  select sh.id, sh.device_id, sh.opened_at, sh.closed_at, sh.opening_float, sh.expected_cash, sh.counted_cash,
         ob.name as opened_by, cb.name as closed_by, d.name as till, d.code,
         ${CASH_TAKEN()} as cash_taken, ${MOVED("in")} as cash_in, ${MOVED("out")} as cash_out,
         (select dc.number from day_closes dc where dc.tenant_id = sh.tenant_id and dc.device_id = sh.device_id and dc.closed_at = sh.closed_at and dc.deleted_at is null limit 1) as close_no
    from shifts sh
    join pos_devices d on d.tenant_id = sh.tenant_id and d.id = sh.device_id
    left join employees ob on ob.tenant_id = sh.tenant_id and ob.id = sh.opened_by
    left join employees cb on cb.tenant_id = sh.tenant_id and cb.id = sh.closed_by
   where sh.tenant_id = $1 and sh.id = $2 and sh.deleted_at is null`;

// Everything that touched that drawer, in the order it happened: each cash
// payment and cash refund, cash put in and taken out, the drawer opened with
// no sale, and each count. `amount` is what it did to the drawer (nothing,
// for an opening or a count). $1 tenant, $2 the shift.
export const LEDGER = `
  select x.at, x.kind, x.ref, x.words, x.who, x.amount, x.counted, x.expected from (
    select coalesce(r.device_time, r.created_at) as at, r.type::text as kind, r.number::text as ref, pt.name as words, e.name as who,
           (case when r.type = 'refund' then -p.amount else p.amount end)::bigint as amount, null::bigint as counted, null::bigint as expected
      from shifts sh
      join receipts r on ${IN_SHIFT("r")}
      join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
      join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind = 'cash'
      left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
     where sh.tenant_id = $1 and sh.id = $2
    union all
    select coalesce(m.device_time, m.created_at), 'cash_' || m.type::text, null, m.reason, e.name,
           (case m.type::text when 'in' then m.amount when 'out' then -m.amount else 0 end)::bigint, null, null
      from shifts sh
      join cash_movements m on ${IN_SHIFT("m")}
      left join employees e on e.tenant_id = m.tenant_id and e.id = m.employee_id
     where sh.tenant_id = $1 and sh.id = $2
    union all
    select coalesce(c.device_time, c.created_at), 'count', null, null, e.name, 0::bigint, c.counted, c.expected
      from drawer_counts c
      left join employees e on e.tenant_id = c.tenant_id and e.id = c.employee_id
     where c.tenant_id = $1 and c.shift_id = $2 and c.deleted_at is null
  ) x
  order by x.at, x.kind`;

export type Entry = { at: string; kind: string; ref: string | null; words: string | null; who: string | null; amount: string; counted: string | null; expected: string | null };
