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

export function stateLine(state: TillState, seen: Date | null, now: Date): string {
  switch (state) {
    case "off": return "Deactivated";
    case "never": return "Not synced yet";
    case "ok": return `Synced ${ago(seen!, now)}`;
    case "idle": return `Last synced ${ago(seen!, now)}`;
  }
}

// ---- a till's own page ----

// Its tabs, after Carfection's device page: what the address calls each, and
// what the page does.
export const TABS = [["general", "General"], ["settings", "Settings"], ["cash", "Cash flow"], ["trace", "Traceability"]] as const;
export type Tab = (typeof TABS)[number][0];
export const tabOf = (v: string | undefined): Tab => TABS.find(([key]) => key === v)?.[0] ?? "general";

const TILL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITTEN_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Where an address of the three pages there used to be goes now. Tills is
// the cards; Till activity and Cash flow are tabs of the till they named,
// and the cards when they named none. Whether a day written as one is a day
// of the calendar is the page's to say.
export function movedTo(page: "tills" | "activity" | "cash", sp: { till?: string; day?: string }): string {
  if (page === "tills" || !sp.till || !TILL_ID.test(sp.till)) return "/backoffice/pos";
  if (page === "cash") return `/backoffice/pos/${sp.till}?tab=cash`;
  const day = sp.day && WRITTEN_DAY.test(sp.day) ? `&from=${sp.day}&to=${sp.day}` : "";
  return `/backoffice/pos/${sp.till}?tab=trace${day}`;
}

// A drawer counted against what it should have held. Nothing, for a day that
// was not counted.
export function variance(counted: unknown, expected: unknown): { off: number; tone: "green" | "red" | "amber"; word: "Balanced" | "Short" | "Over" } | null {
  if (counted === null || counted === undefined || expected === null || expected === undefined) return null;
  const off = Number(counted) - Number(expected);
  return off === 0 ? { off, tone: "green", word: "Balanced" } : off < 0 ? { off, tone: "red", word: "Short" } : { off, tone: "amber", word: "Over" };
}

// The events of a timeline under their days, in the order they came: the day
// is the one in the business's own timezone, written 2026-10-09.
export function byDay<E extends { at: string }>(events: E[], tz: string): { day: string; events: E[] }[] {
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const out: { day: string; events: E[] }[] = [];
  for (const e of events) {
    const day = dayOf.format(new Date(e.at));
    if (out.length === 0 || out[out.length - 1].day !== day) out.push({ day, events: [] });
    out[out.length - 1].events.push(e);
  }
  return out;
}

// What each kind of event is called, and the colour of its mark.
export const EVENT: Record<string, [string, string]> = {
  sale: ["Sale", "green"],
  refund: ["Refund", "red"],
  cash_in: ["Cash in", "green"],
  cash_out: ["Cash out", "amber"],
  cash_drawer: ["Drawer opened", "amber"],
  count: ["Drawer counted", "blue"],
  open: ["Day opened", "blue"],
  close: ["Day closed", "blue"],
  clock_in: ["Clocked in", ""],
  clock_out: ["Clocked out", ""],
  crash: ["App stopped unexpectedly", "red"],
};

// What an event says about itself, under its name. `m` writes an amount as
// the business writes money.
export function eventDetail(e: Event, m: (v: string | number | null) => string): string {
  const differs = (counted: string | null, expected: string | null) => {
    const v = variance(counted, expected);
    return v === null ? "" : v.off === 0 ? ", balanced" : `, ${v.off < 0 ? "short" : "over"} by ${m(Math.abs(v.off))}`;
  };
  const counted = () => `Counted ${m(e.amount)}, expected ${m(e.extra)}${differs(e.amount, e.extra)}`;
  const and = (a: string, b: string | null) => (b ? `${a} · ${b}` : a);
  switch (e.kind) {
    case "sale": return and(e.ref ?? "", e.amount === null ? null : m(e.amount));
    case "refund": return and(e.ref ?? "", e.amount === null ? null : "-" + m(e.amount));
    case "cash_in": return and(m(e.amount), e.words);
    case "cash_out": return and("-" + m(e.amount), e.words);
    case "cash_drawer": return "With no sale";
    case "count": return counted();
    case "open": return `Opening float ${m(e.amount)}`;
    case "close": return `Day closing no. ${e.ref}` + (e.amount !== null && e.extra !== null ? `. ${counted()}` : "");
    case "crash": return (e.words ?? "") + (e.ref ? ` (version ${e.ref})` : "");
    default: return "";
  }
}

// A payment into or out of a till, as the Cash flow tab lists them.
export type Move = { at: string; dir: "in" | "out"; who: string | null; method: string; ref: string | null; amount: string; type: string; comment: string | null };

// The payments of a period, in and out apart, each with its total.
export function splitMoves<M extends Move>(rows: M[]): { inflows: M[]; outflows: M[]; inTotal: number; outTotal: number } {
  const inflows = rows.filter((r) => r.dir === "in");
  const outflows = rows.filter((r) => r.dir === "out");
  const sum = (list: M[]) => list.reduce((a, r) => a + Number(r.amount), 0);
  return { inflows, outflows, inTotal: sum(inflows), outTotal: sum(outflows) };
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

// What a till did from one day to another, newest first: its day opened and
// closed, each sale and refund, cash put in and taken out, the drawer opened
// with no sale and counted, people clocking in and out on it, and the app
// stopping unexpectedly. `late` is how many seconds after the till wrote it
// down the server had it: a sale made offline shows here. $1 tenant, $2 the
// first day, $3 the last, $4 a till or null for all of them, $5 how many at
// most, $6 the timezone the days are in.
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
   where ev.at >= ($2::date::timestamp at time zone $6::text)
     and ev.at < (($3::date + 1)::timestamp at time zone $6::text)
     and ($4::uuid is null or ev.device_id = $4::uuid)
   order by ev.at desc
   limit $5`;

export type Event = {
  at: string; kind: string; device_id: string | null; till: string | null; code: string | null; who: string | null;
  ref: string | null; words: string | null; amount: string | null; extra: string | null; late: number | null; total: number;
};

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

// ---- the cards, and a till's own page ----

// A payment's amount as it counts for the till: a refund gives it back.
const SIGNED = `case when r.type = 'refund' then -p.amount else p.amount end`;

// The days that were closed, newest first, across every till: what each
// drawer should have held and what was counted in it. $1 tenant, $2 how many.
export const CASH_UPS = `
  select sh.id, sh.device_id, d.name as till, d.code, sh.opened_at, sh.closed_at, sh.expected_cash, sh.counted_cash
    from shifts sh
    join pos_devices d on d.tenant_id = sh.tenant_id and d.id = sh.device_id
   where sh.tenant_id = $1 and sh.deleted_at is null and sh.closed_at is not null
   order by sh.closed_at desc
   limit $2`;

export type CashUp = { id: string; device_id: string; till: string; code: string; opened_at: string; closed_at: string; expected_cash: string | null; counted_cash: string | null };

// What a till took on one day, by payment method: its sales, less what it
// gave back. A payment whose type was corrected counts as what it became.
// $1 tenant, $2 the till, $3 the day, $4 the timezone the day is in.
export const TAKEN = `
  select pt.name, pt.kind::text as kind, sum(${SIGNED})::bigint as amount
    from receipts r
    join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
    join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id
   where r.tenant_id = $1 and r.device_id = $2 and r.deleted_at is null
     and (coalesce(r.device_time, r.created_at) at time zone $4::text)::date = $3::date
   group by pt.name, pt.kind, pt.sort_order
   order by pt.sort_order, pt.name`;

export type Taken = { name: string; kind: string; amount: string };

// A till's days, newest first, with who opened and closed each, what was
// counted and what was expected. A day still open says what moved its drawer
// so far. $1 tenant, $2 the till, $3 how many.
export const DAYS = `
  select sh.id, sh.opened_at, sh.closed_at, ob.name as opened_by, cb.name as closed_by, sh.opening_float, sh.expected_cash, sh.counted_cash,
         case when sh.closed_at is null then ${CASH_TAKEN()} end as cash_taken,
         case when sh.closed_at is null then ${MOVED("in")} end as cash_in,
         case when sh.closed_at is null then ${MOVED("out")} end as cash_out
    from shifts sh
    left join employees ob on ob.tenant_id = sh.tenant_id and ob.id = sh.opened_by
    left join employees cb on cb.tenant_id = sh.tenant_id and cb.id = sh.closed_by
   where sh.tenant_id = $1 and sh.device_id = $2 and sh.deleted_at is null
   order by sh.opened_at desc
   limit $3`;

export type TillDay = {
  id: string; opened_at: string; closed_at: string | null; opened_by: string | null; closed_by: string | null; opening_float: string;
  expected_cash: string | null; counted_cash: string | null; cash_taken: string | null; cash_in: string | null; cash_out: string | null;
};

// The days a till closed on one date, newest first, as each drawer was left:
// its float, the cash it took, what was put in and paid out, what was counted
// against what was expected, and what did not go in the drawer at all, by
// payment method. $1 tenant, $2 the till, $3 the date, $4 the timezone.
export const CLOSURES = `
  select sh.id, sh.opened_at, sh.closed_at, sh.opening_float, sh.expected_cash, sh.counted_cash, ob.name as opened_by, cb.name as closed_by,
         ${CASH_TAKEN()} as cash_taken, ${MOVED("in")} as cash_in, ${MOVED("out")} as cash_out,
         (select dc.number from day_closes dc where dc.tenant_id = sh.tenant_id and dc.device_id = sh.device_id and dc.closed_at = sh.closed_at and dc.deleted_at is null limit 1) as close_no,
         coalesce((select jsonb_agg(jsonb_build_object('name', q.name, 'amount', q.amount) order by q.sort_order, q.name)
            from (select pt.name, pt.sort_order, sum(${SIGNED})::bigint as amount
                    from receipts r
                    join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                    join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind <> 'cash'
                   where ${IN_SHIFT("r")}
                   group by pt.name, pt.sort_order
                  having sum(${SIGNED}) <> 0) q), '[]'::jsonb) as non_cash,
         -- closed because the back office asked (0091): who asked, and whether they typed a count
         (select jsonb_build_object('who', e.name, 'counted', q.counted_cash is not null)
            from till_requests q
            left join employees e on e.tenant_id = q.tenant_id and e.id = q.requested_by
           where q.tenant_id = sh.tenant_id and q.shift_id = sh.id and q.kind = 'close_day' and q.status = 'done' and q.deleted_at is null
           limit 1) as asked
    from shifts sh
    left join employees ob on ob.tenant_id = sh.tenant_id and ob.id = sh.opened_by
    left join employees cb on cb.tenant_id = sh.tenant_id and cb.id = sh.closed_by
   where sh.tenant_id = $1 and sh.device_id = $2 and sh.deleted_at is null and sh.closed_at is not null
     and (sh.closed_at at time zone $4::text)::date = $3::date
   order by sh.closed_at desc`;

export type Closure = {
  id: string; opened_at: string; closed_at: string; opening_float: string; expected_cash: string | null; counted_cash: string | null;
  opened_by: string | null; closed_by: string | null; cash_taken: string; cash_in: string; cash_out: string; close_no: number | null;
  non_cash: { name: string; amount: number }[];
  asked: { who: string | null; counted: boolean } | null;
};

// Every payment into and out of a till from one day to another, newest
// first: each payment of each sale and refund, whatever it was paid with, and
// the cash put in and paid out. The drawer opened with no sale moved nothing
// and is not here. Each line says how many its side has in all; only the
// latest of each side are handed over. $1 tenant, $2 the till, $3 the first
// day, $4 the last, $5 the timezone, $6 how many of each side at most.
export const MOVES = `
  select y.at, y.dir, y.who, y.method, y.ref, y.amount, y.type, y.comment, y.total
    from (
      select x.*, count(*) over (partition by x.dir)::int as total, row_number() over (partition by x.dir order by x.at desc) as n
        from (
          select coalesce(r.device_time, r.created_at) as at, case when r.type = 'refund' then 'out' else 'in' end as dir, e.name as who, pt.name as method,
                 r.number::text as ref, p.amount::bigint as amount, case when r.type = 'refund' then 'Refund' else 'Sale' end as type,
                 case when r.type = 'refund' and o.number is not null then 'Refund of ' || o.number::text end as comment
            from receipts r
            join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
            join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id
            left join receipts o on o.tenant_id = r.tenant_id and o.id = r.refund_of
            left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
           where r.tenant_id = $1 and r.device_id = $2 and r.deleted_at is null
          union all
          select coalesce(m.device_time, m.created_at), m.type::text, e.name, 'Cash', null, m.amount::bigint,
                 case m.type::text when 'in' then 'Cash in' else 'Cash out' end, m.reason
            from cash_movements m
            left join employees e on e.tenant_id = m.tenant_id and e.id = m.employee_id
           where m.tenant_id = $1 and m.device_id = $2 and m.deleted_at is null and m.type::text in ('in', 'out')
        ) x
       where x.at >= ($3::date::timestamp at time zone $5::text)
         and x.at < (($4::date + 1)::timestamp at time zone $5::text)
    ) y
   where y.n <= $6
   order by y.at desc`;

// A till named again by its own business. The code is never changed: it is
// in every receipt number the till has issued. $1 tenant, $2 the till, $3
// the name.
export const RENAME = `update pos_devices set name = $3 where tenant_id = $1 and id = $2 returning id`;

// A till deactivated, or reactivated: what /admin does (0045), by the
// business itself. $1 tenant, $2 the till, $3 whether it is active.
export const SET_ACTIVE = `
  update pos_devices set deleted_at = case when $3::boolean then null else now() end
   where tenant_id = $1 and id = $2 returning id`;

// ---- what the back office asks of a till (migration 0091) ----
//
// A till owns its day, so the back office closes nothing and moves no cash:
// it leaves a request, and the till carries it out the next time it syncs,
// with its own figures, then answers.

// The first build of the till that carries requests out (till_request_build()).
export const REQUEST_BUILD = 12;
export const takesRequests = (t: { till_version: number | null; off: boolean }) => !t.off && t.till_version !== null && t.till_version >= REQUEST_BUILD;

// What was asked of the tills, newest first. $1 tenant, $2 a till or null for
// all of them, $3 true for those still waiting only, $4 how many.
export const ASKED = `
  select q.id, q.device_id, q.shift_id, q.kind, q.counted_cash, q.amount, q.reason, q.status, q.note, q.requested_at, q.answered_at, e.name as who
    from till_requests q
    left join employees e on e.tenant_id = q.tenant_id and e.id = q.requested_by
   where q.tenant_id = $1 and q.deleted_at is null
     and ($2::uuid is null or q.device_id = $2::uuid)
     and ($3::boolean is not true or q.status = 'waiting')
   order by q.requested_at desc
   limit $4`;

export type Asked = {
  id: string; device_id: string; shift_id: string; kind: "close_day" | "cash_out"; counted_cash: string | null; amount: string | null; reason: string | null;
  status: "waiting" | "done" | "refused" | "cancelled"; note: string | null; requested_at: string; answered_at: string | null; who: string | null;
};

// What may be asked by this person: what their role lets them do on a till.
// $1 the employee.
export const MAY_ASK = `select has_perm($1, 'shift.open_close') as close, has_perm($1, 'cash.pay_in_out') as cash`;

export function askSays(q: Asked, m: (v: string | number | null) => string): string {
  if (q.kind === "cash_out") return `Take ${m(q.amount)} out` + (q.reason ? ` · ${q.reason}` : "");
  return q.counted_cash === null ? "Close the day at what the till expects" : `Close the day, counted ${m(q.counted_cash)}`;
}

// How a request ended, and the colour of its tag.
export function askEnded(q: Asked): [string, string] {
  switch (q.status) {
    case "waiting": return ["Waiting for the till to sync", "amber"];
    case "done": return ["Done", "green"];
    case "cancelled": return ["Cancelled", ""];
    case "refused": return [q.note ? `Refused: ${q.note}` : "Refused by the till", "red"];
  }
}

// What till_request and till_request_cancel refuse with, in words. Anything
// else the database says is not shown as it came.
const REFUSED: Record<string, string> = {
  forbidden: "Your role does not include doing this on a till.",
  "bad-kind": "That is not something a till can be asked.",
  "bad-device": "That till is not one of yours, or was deactivated.",
  "till-too-old": "This till's build does not take requests from the back office. Update the till first.",
  "no-day-open": "This till has no day open, as far as it has synced.",
  "already-asked": "A closing is already waiting for this till.",
  "bad-amount": "Type an amount above nothing.",
  "reason-required": "Say what the cash is for.",
  "bad-request": "That request is not one of yours.",
  "not-waiting": "The till has already answered it, or it was cancelled.",
};
export const refusal = (code: unknown): string => REFUSED[String(code)] ?? "That could not be asked. Nothing was changed.";

// A till's name as typed: trimmed, and nothing when it is empty or longer
// than a card can show.
export const cleanName = (v: unknown): string | null => {
  const name = String(v ?? "").trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 40 ? name : null;
};
