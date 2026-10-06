import Link from "next/link";
import type { PoolClient } from "pg";
import { ArrowUpRight, Boxes, CalendarClock, ClipboardList, type LucideIcon, TrendingUp, UtensilsCrossed } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { fmtRs } from "@/lib/money";
import { clock, fmtQty, RECEIPTS } from "@/lib/report";
import { SalesChart, type Day } from "./dash-chart";
import { Card } from "./ui";

// ---- dates: plain calendar days (YYYY-MM-DD), never a JS local time ----
const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const isDay = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s).getTime());
const span = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000) + 1;
const long = (s: string) =>
  parse(s).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).replace(",", "");
const weekday = (s: string) => parse(s).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const fullDate = (s: string) =>
  parse(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(",", "");

function presets(today: string) {
  const first = today.slice(0, 8) + "01";
  const lastOfMonth = (firstDay: string) => {
    const d = parse(firstDay);
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    return iso(d);
  };
  const prevFirst = iso(new Date(Date.UTC(parse(first).getUTCFullYear(), parse(first).getUTCMonth() - 1, 1)));
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: addDays(today, -1), to: addDays(today, -1) },
    { label: "Last 7 days", from: addDays(today, -6), to: today },
    { label: "Last 30 days", from: addDays(today, -29), to: today },
    { label: "This month", from: first, to: lastOfMonth(first) },
    { label: "Last month", from: prevFirst, to: lastOfMonth(prevFirst) },
  ];
}

// ---- right now: what is true this minute, whatever days are picked below ----
//
//   - an open order is one a tablet has not closed, with something on it still
//     to pay or a table it is holding. An order opened and left empty is not
//     counted: nobody is waiting on it;
//   - what is on the open orders is their items at menu prices, as the lines
//     stand: before any service charge or discount, which the till works out
//     when the bill is asked for;
//   - today's sales are compared with the same weekday last week up to the
//     same time on the clock, so a half-finished day is set against half a
//     day and not against a whole one;
//   - the money is for those who may see reports. Everyone else gets the
//     counts.
// $1 tenant, $2 the employee looking.
const NOW = `
  with clk as (
    select z.tz, (now() at time zone z.tz)::date as today, (now() at time zone z.tz)::time as nowt,
           coalesce(has_perm($2, 'reports.view'), false) as can
      from (select coalesce((select s.timezone from stores s where s.tenant_id = $1 and s.deleted_at is null order by s.created_at limit 1),
                            'Indian/Mauritius') as tz) z
  ),
  ot as (
    select t.id, t.created_at, t.table_id,
           (select count(*) from ticket_lines l
             where l.tenant_id = t.tenant_id and l.ticket_id = t.id and l.voided_at is null and l.deleted_at is null and l.paid is not true) as live,
           (select coalesce(sum(line_amount(l.unit_price, l.qty)
                     + coalesce((select sum(m.price) from ticket_line_modifiers m
                                  where m.tenant_id = l.tenant_id and m.line_id = l.id and m.deleted_at is null), 0)), 0)
              from ticket_lines l
             where l.tenant_id = t.tenant_id and l.ticket_id = t.id and l.voided_at is null and l.deleted_at is null and l.paid is not true) as amount
      from tickets t
     where t.tenant_id = $1 and t.status = 'open' and t.deleted_at is null
  ),
  oo as (select * from ot where live > 0 or table_id is not null),
  rv as (
    select v.id, v.type, v.ticket_id, v.signed_total,
           coalesce(v.device_time, v.created_at) at time zone s.timezone as lt
      from receipt_revenue v
      join stores s on s.tenant_id = v.tenant_id and s.id = v.store_id
     cross join clk
     where clk.can and v.tenant_id = $1 and v.counts_as_sale
       and coalesce(v.device_time, v.created_at) > now() - interval '9 days'
  ),
  bk as (
    select b.name, b.size, b.status, b.booked_for, to_char(b.booked_for at time zone clk.tz, 'HH24:MI') as clock
      from bookings b cross join clk
     where b.tenant_id = $1 and b.deleted_at is null and b.status in ('pending', 'confirmed', 'seated')
       and (b.booked_for at time zone clk.tz)::date = clk.today
  ),
  st as (
    select i.name, i.is_available, coalesce(i.stock_qty, 0) as q, (i.track_stock or coalesce(c.is_stock, false)) as tracked
      from items i left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
     where i.tenant_id = $1 and i.deleted_at is null
  )
  select clk.today::text as today, clk.tz, extract(hour from clk.nowt)::int as hour, clk.can,
         (select s.name from stores s where s.tenant_id = $1 and s.deleted_at is null order by s.created_at limit 1) as store,
         (select s.address from stores s where s.tenant_id = $1 and s.deleted_at is null order by s.created_at limit 1) as address,
         (select e.name from employees e where e.tenant_id = $1 and e.id = $2) as me,
         -- flagged = still open: no recorded reason yet, or a reason not resolved
         (select count(*)::int from receipts r
           where r.deleted_at is null and r.tenant_id = $1 and r.needs_review
             and (not exists (select 1 from receipt_reviews v
                               where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)
               or exists (select 1 from receipt_reviews v
                           where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null
                             and v.resolved_at is null))) as flagged,
         (select count(*)::int from oo) as open_n,
         (select count(*)::int from oo where table_id is not null) as open_tables,
         case when clk.can then (select coalesce(sum(amount), 0)::float8 from oo) end as open_amount,
         (select (extract(epoch from now() - min(created_at)) / 60)::int from oo) as open_oldest,
         (select count(*)::int from tables tb where tb.tenant_id = $1 and tb.deleted_at is null) as tables,
         (select count(*)::int from bk) as book_n,
         (select coalesce(sum(size), 0)::int from bk) as book_guests,
         (select json_build_object('name', name, 'clock', clock, 'size', size) from bk
           where status <> 'seated' and booked_for > now() - interval '15 minutes' order by booked_for limit 1) as book_next,
         (select count(*)::int from st where not is_available) as sold_out,
         (select json_agg(x.name) from (select name from st where not is_available order by name limit 3) x) as sold_out_names,
         (select count(*)::int from st where tracked) as tracked,
         (select count(*)::int from st where tracked and q <= 5000) as low,
         (select json_build_object('since', sh.opened_at, 'by', e.name)
            from shifts sh left join employees e on e.tenant_id = sh.tenant_id and e.id = sh.opened_by
           where sh.tenant_id = $1 and sh.deleted_at is null and sh.closed_at is null order by sh.opened_at limit 1) as shift,
         (select coalesce(sum(signed_total), 0)::float8 from rv where lt::date = clk.today) as today_total,
         (select count(distinct ticket_id)::int from rv where lt::date = clk.today and type = 'sale') as today_orders,
         (select coalesce(sum(case when rv.type = 'refund' then -rl.qty else rl.qty end), 0)::int
            from rv join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = rv.id where rv.lt::date = clk.today) as today_items,
         (select coalesce(sum(signed_total), 0)::float8 from rv where lt::date = clk.today - 7 and lt::time <= clk.nowt) as week_ago
    from clk`;

type Now = {
  today: string; tz: string; hour: number; can: boolean; store: string | null; address: string | null; me: string | null; flagged: number;
  open_n: number; open_tables: number; open_amount: number | null; open_oldest: number | null; tables: number;
  book_n: number; book_guests: number; book_next: { name: string; clock: string; size: number } | null;
  sold_out: number; sold_out_names: string[] | null; tracked: number; low: number;
  shift: { since: string; by: string | null } | null;
  today_total: number; today_orders: number; today_items: number; week_ago: number;
};

// ---- the days picked ----
//
// Every figure starts from the same receipts the reports start from, so the
// gross here is the Sales summary's total and the top sellers are the top of
// Item sales for the same days:
//   - a receipt that counts as a sale (a double payment for goods already
//     sold is money to give back, not a sale);
//   - a refund subtracts;
//   - the day is the day on the till's clock when the receipt was issued, in
//     the store's time zone.
type Split = { name: string | null; n: number; amount: number };
type Range = {
  gross: number; tax: number; discounts: number; refunds: number; accounts: number; covers: number; seated: number; days: Day[];
  top: { name: string; cat: string | null; qty: number; amount: number }[];
  cats: { name: string; qty: number; amount: number }[];
  payments: Split[]; dining: Split[]; staff: Split[];
  hours: { hour: number; n: number; amount: number }[];
};

async function loadRange(c: PoolClient, tenantId: string, from: string, to: string, full: boolean): Promise<Range> {
  // the days before are only compared in total, so their breakdowns are left out
  const part = (sql: string) => (full ? `(select json_agg(t) from (${sql}) t)` : "null::json");
  const row = (
    await c.query(
      `with r as (${RECEIPTS}),
       il as (
         select r.sign, rl.name_snapshot as name, coalesce(k.name, 'No category') as cat, rl.qty,
                line_amount(rl.unit_price, rl.qty) + coalesce((select sum(m.price) from receipt_line_modifiers m
                   where m.tenant_id = $1 and m.receipt_line_id = rl.id), 0) as amount
           from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
           left join ticket_lines tl on tl.tenant_id = $1 and tl.id = rl.ticket_line_id
           left join items i on i.tenant_id = $1 and i.id = tl.item_id
           left join categories k on k.tenant_id = $1 and k.id = i.category_id
       )
       select (select json_build_object(
                 'gross', coalesce(sum(signed_total), 0), 'tax', coalesce(sum(sign * tax_total), 0),
                 'discounts', coalesce(sum(sign * discount_total), 0),
                 'refunds', coalesce(sum(total) filter (where type = 'refund'), 0),
                 -- what the orders that say how many guests they were came to
                 'seated', coalesce(sum(signed_total) filter (where covers > 0), 0),
                 -- an account is an order: a bill split into three receipts is one account
                 'accounts', count(distinct ticket_id) filter (where type = 'sale')) from r) as totals,
              (select coalesce(sum(z.covers), 0)::int
                 from (select distinct on (ticket_id) ticket_id, covers from r where type = 'sale' and ticket_id is not null) z) as covers,
              (select json_agg(json_build_object('day', d::date::text, 'gross', coalesce(x.gross, 0)) order by d)
                 from generate_series($2::date, $3::date, interval '1 day') d
                 left join (select day, sum(signed_total) as gross from r group by day) x on x.day = d::date) as days,
              ${part(`select name, max(cat) as cat, sum(sign * qty)::int as qty, sum(sign * amount)::bigint as amount
                        from il group by name order by 4 desc, 1 limit 5`)} as top,
              ${part(`select cat as name, sum(sign * qty)::int as qty, sum(sign * amount)::bigint as amount
                        from il group by cat order by 3 desc, 1 limit 5`)} as cats,
              ${part(`select pt.name, count(*)::int as n, sum(r.sign * p.amount)::bigint as amount
                        from r join receipt_payments_effective p on p.tenant_id = $1 and p.receipt_id = r.id
                        left join payment_types pt on pt.tenant_id = $1 and pt.id = p.payment_type_id
                       group by pt.name order by 3 desc`)} as payments,
              ${part(`select o.name, count(*)::int as n, sum(r.signed_total)::bigint as amount
                        from r left join dining_options o on o.tenant_id = $1 and o.id = r.dining_option_id
                       group by o.name order by 3 desc`)} as dining,
              ${part(`select e.name, count(*)::int as n, sum(r.signed_total)::bigint as amount
                        from r left join employees e on e.tenant_id = $1 and e.id = r.employee_id
                       group by e.name order by 3 desc limit 6`)} as staff,
              ${part(`select extract(hour from (r.at at time zone r.timezone))::int as hour,
                             count(*) filter (where type = 'sale')::int as n, sum(signed_total)::bigint as amount
                        from r group by 1 order by 1`)} as hours`,
      [tenantId, from, to, null, null, "all"],
    )
  ).rows[0];
  const t = row.totals as Record<string, number>;
  const list = <T extends { amount: number }>(v: T[] | null): T[] => (v ?? []).map((x) => ({ ...x, amount: Number(x.amount) }));
  return {
    gross: Number(t.gross), tax: Number(t.tax), discounts: Number(t.discounts), refunds: Number(t.refunds), accounts: Number(t.accounts),
    covers: Number(row.covers), seated: Number(t.seated),
    days: ((row.days ?? []) as { day: string; gross: number }[]).map((d) => ({ day: d.day, gross: Number(d.gross) })),
    top: list(row.top), cats: list(row.cats), payments: list(row.payments), dining: list(row.dining), staff: list(row.staff), hours: list(row.hours),
  };
}

type Recent = { number: string; type: string; total: number; at: string; tbl: string | null; order_no: string | null; order_name: string | null; staff: string | null; paid_by: string | null };

const RECENT = `
  select v.number, v.type, v.signed_total::float8 as total, coalesce(v.device_time, v.created_at) as at,
         tb.name as tbl, t.order_no, t.name as order_name, e.name as staff,
         (select string_agg(distinct pt.name, ', ') from receipt_payments_effective p
            left join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id
           where p.tenant_id = v.tenant_id and p.receipt_id = v.id) as paid_by
    from receipt_revenue v
    left join tickets t on t.tenant_id = v.tenant_id and t.id = v.ticket_id
    left join tables tb on tb.tenant_id = v.tenant_id and tb.id = t.table_id
    left join employees e on e.tenant_id = v.tenant_id and e.id = v.employee_id
   where v.tenant_id = $1 and v.counts_as_sale
   order by coalesce(v.device_time, v.created_at) desc limit 6`;

function change(now: number, before: number) {
  if (before === 0) return now === 0 ? null : { text: "new", up: now > 0 };
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return { text: (pct > 0 ? "+" : "") + pct + "%", up: pct >= 0 };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
// kept on one line: the spaces inside are non-breaking
const age = (min: number) =>
  (min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${Math.floor(min / 1440)} days`).replace(/ /g, " ");
const greeting = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

function Tile({
  icon: Icon, label, value, unit, delta, hint, href,
}: {
  icon: LucideIcon; label: string; value: string; unit?: string; delta?: { text: string; up: boolean } | null; hint: string; href?: string;
}) {
  const body = (
    <>
      <div className="tile-label">
        <Icon aria-hidden="true" strokeWidth={1.9} />
        {label}
      </div>
      <div className="tile-value">
        <span>{value}</span>
        {unit && <small>{unit}</small>}
        {/* up is green; down is amber, not red: a slow weekday is something to know, not a fault */}
        {delta && <em className={delta.up ? "delta up" : "delta down"}>{delta.text}</em>}
      </div>
      <div className="tile-hint">{hint}</div>
    </>
  );
  return href ? (
    <Link href={href} className="tile">
      {body}
    </Link>
  ) : (
    <div className="tile">{body}</div>
  );
}

const More = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} className="card-link">
    {children}
    <ArrowUpRight aria-hidden="true" />
  </Link>
);

// A short list with a bar for each row's share of the whole.
function Shares({ rows, total, none, count }: { rows: Split[]; total: number; none: string; count?: boolean }) {
  if (rows.length === 0) return <p className="dash-empty">Nothing sold in these days.</p>;
  return (
    <ul className="rank">
      {rows.map((r, i) => {
        const share = total > 0 ? Math.max(0, Math.min(100, (r.amount / total) * 100)) : 0;
        return (
          <li key={i}>
            <div className="rank-row">
              <b>{r.name ?? <span className="muted">{none}</span>}</b>
              <strong>{fmtRs(r.amount)}</strong>
            </div>
            <span className="bar">
              <i style={{ width: `${share}%` }} />
            </span>
            <small>
              {count === false ? "" : `${plural(r.n, "receipt", "receipts")} · `}
              {share.toFixed(0)}% of sales
            </small>
          </li>
        );
      })}
    </ul>
  );
}

const CALENDAR =
  "M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z";

export default async function BackofficeHome({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; compare?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const compare = sp.compare === "1";
  const data = await readTenant(ctx.tenantId, async (c) => {
    const now = (await c.query(NOW, [ctx.tenantId, ctx.employeeId])).rows[0] as Now;
    const options = presets(now.today);
    // default: this month. A range that is malformed, backwards or longer
    // than a year falls back to it.
    let { from, to } = options.find((o) => o.label === "This month")!;
    if (isDay(sp.from) && isDay(sp.to) && sp.from <= sp.to && span(sp.from, sp.to) <= 366) {
      from = sp.from;
      to = sp.to;
    }
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(span(from, to) - 1));
    if (!now.can) return { now, options, from, to, prevFrom, prevTo, cur: null, prev: null, recent: [] as Recent[] };
    const cur = await loadRange(c, ctx.tenantId, from, to, true);
    const prev = compare ? await loadRange(c, ctx.tenantId, prevFrom, prevTo, false) : null;
    const recent = (await c.query(RECENT, [ctx.tenantId])).rows as Recent[];
    return { now, options, from, to, prevFrom, prevTo, cur, prev, recent };
  });
  const { now, from, to, cur, prev } = data;
  const href = (f: string, t: string, cmp: boolean) => `/backoffice?from=${f}&to=${t}${cmp ? "&compare=1" : ""}`;
  const days = `from=${from}&to=${to}`;
  const at = clock(now.tz);

  const soldOut = now.sold_out_names ?? [];
  const tiles = (
    <div className="tiles">
      {now.can && (
        <Tile
          icon={TrendingUp}
          label="Today's sales"
          value={fmtRs(now.today_total)}
          delta={now.week_ago > 0 ? change(now.today_total, now.week_ago) : null}
          hint={
            `${plural(now.today_orders, "order", "orders")} paid, ${fmtQty(now.today_items)} items` +
            (now.week_ago > 0 ? ` · against last ${weekday(now.today)} by this time` : "")
          }
          href={`/backoffice/reports/sales?from=${now.today}&to=${now.today}`}
        />
      )}
      <Tile
        icon={ClipboardList}
        label="Open orders"
        value={String(now.open_n)}
        unit={now.open_n === 1 ? "order" : "orders"}
        hint={
          now.open_n === 0
            ? "Nothing is waiting to be paid"
            : [
                now.tables > 0 ? `${now.open_tables} of ${plural(now.tables, "table", "tables")}` : null,
                now.open_amount != null ? `${fmtRs(now.open_amount)} of items` : null,
                now.open_oldest != null ? `oldest ${age(now.open_oldest)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")
        }
      />
      <Tile
        icon={CalendarClock}
        label="Bookings today"
        value={String(now.book_n)}
        unit={now.book_n === 1 ? "booking" : "bookings"}
        hint={
          now.book_n === 0
            ? "None for today"
            : plural(now.book_guests, "guest", "guests") +
              (now.book_next ? ` · next ${now.book_next.clock}, ${now.book_next.name} (${now.book_next.size})` : " · none still to come")
        }
        href="/backoffice/bookings"
      />
      <Tile
        icon={UtensilsCrossed}
        label="Sold out"
        value={String(now.sold_out)}
        unit={now.sold_out === 1 ? "item" : "items"}
        hint={
          now.sold_out === 0
            ? "Everything is on the menu"
            : soldOut.join(", ") + (now.sold_out > soldOut.length ? ` and ${now.sold_out - soldOut.length} more` : "")
        }
        href="/backoffice/items"
      />
      {now.tracked > 0 && (
        <Tile
          icon={Boxes}
          label="Low stock"
          value={String(now.low)}
          unit={now.low === 1 ? "item" : "items"}
          hint={now.low === 0 ? `All ${plural(now.tracked, "counted item", "counted items")} above five` : "Five or fewer left"}
          href={now.low > 0 ? "/backoffice/stock?show=low" : "/backoffice/stock"}
        />
      )}
    </div>
  );

  const head = (
    <>
      {now.flagged > 0 && (
        <div className="bo-banner warn">
          <strong>
            {now.flagged} {now.flagged === 1 ? "receipt needs" : "receipts need"} review.
          </strong>
          A till reported something that does not add up (a price that changed, a payment that was short or doubled).{" "}
          <Link href="/backoffice/receipts">Open receipts</Link>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>
            {greeting(now.hour)}
            {now.me ? `, ${now.me.trim().split(/\s+/)[0]}` : ""}
          </h1>
          <p className="lede">
            {fullDate(now.today)}
            {now.store ? ` · ${now.store}` : ""}
            {now.address ? `, ${now.address}` : ""}
            {" · "}
            {now.shift ? `sales period open since ${at(now.shift.since)}${now.shift.by ? ` (${now.shift.by})` : ""}` : "no sales period open"}
          </p>
        </div>
        <div className="page-actions no-print">
          <Link href="/backoffice/reports/day-close" className="btn-quiet">Day closing</Link>
          <Link href="/backoffice/bookings" className="btn-quiet">Bookings</Link>
          <Link href="/backoffice/items/edit" className="btn-quiet">Add an item</Link>
        </div>
      </div>
      <div className="dash-sub">
        <h2>Right now</h2>
        <span>On every tablet, as of the last sync</span>
      </div>
      {tiles}
    </>
  );

  if (!cur) {
    return (
      <div>
        {head}
        <div className="note warn">Your role does not include seeing reports, so the sales figures are left out.</div>
      </div>
    );
  }

  const net = (r: Range) => r.gross - r.tax;
  const avg = (r: Range) => (r.accounts > 0 ? Math.round(r.gross / r.accounts) : 0);
  const kpis = [
    { label: "Total gross sales", value: fmtRs(cur.gross), now: cur.gross, before: prev?.gross, money: true,
      note: cur.discounts !== 0 || cur.refunds !== 0 ? `After ${fmtRs(cur.discounts)} of discounts and ${fmtRs(cur.refunds)} of refunds` : "Paid by customers, after discounts and refunds" },
    { label: "Total net sales", value: fmtRs(net(cur)), now: net(cur), before: prev && net(prev), money: true, note: "Gross sales less VAT" },
    { label: "Total taxes", value: fmtRs(cur.tax), now: cur.tax, before: prev?.tax, money: true, note: "VAT inside those sales" },
    { label: "Closed accounts", value: String(cur.accounts), now: cur.accounts, before: prev?.accounts, money: false, note: "Orders paid in the period" },
    { label: "Average per order", value: fmtRs(avg(cur)), now: avg(cur), before: prev && avg(prev), money: true, note: "Gross sales over closed accounts" },
    { label: "Guests served", value: String(cur.covers), now: cur.covers, before: prev?.covers, money: false,
      note: cur.covers > 0 ? `${fmtRs(Math.round(cur.seated / cur.covers))} a guest, on the orders that say how many` : "Guests entered on the orders paid" },
  ];

  const itemsTop = Math.max(1, ...cur.top.map((r) => r.amount));
  const catsTotal = cur.cats.reduce((a, r) => a + r.amount, 0);
  const hours = (() => {
    if (cur.hours.length === 0) return [];
    const by = new Map(cur.hours.map((h) => [h.hour, h]));
    const lo = cur.hours[0].hour, hi = cur.hours[cur.hours.length - 1].hour;
    return Array.from({ length: hi - lo + 1 }, (_, i) => by.get(lo + i) ?? { hour: lo + i, n: 0, amount: 0 });
  })();
  const peak = hours.reduce((a, h) => (h.amount > a.amount ? h : a), { hour: 0, n: 0, amount: 0 });
  const hh = (h: number) => String(h).padStart(2, "0") + ":00";

  return (
    <div>
      {head}
      <div className="dash-controls no-print">
        <details className="range">
          <summary>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={CALENDAR} />
            </svg>
            {long(from)} - {long(to)}
          </summary>
          <div className="range-menu">
            {data.options.map((o) => (
              <Link key={o.label} href={href(o.from, o.to, compare)} className={o.from === from && o.to === to ? "on" : undefined}>
                {o.label}
              </Link>
            ))}
            <form method="get" action="/backoffice">
              <input type="date" name="from" defaultValue={from} required aria-label="From" /> to{" "}
              <input type="date" name="to" defaultValue={to} required aria-label="To" />
              {compare && <input type="hidden" name="compare" value="1" />}
              <button type="submit">Apply</button>
            </form>
          </div>
        </details>
        <span className="spacer" />
        <Link className="compare" href={href(from, to, !compare)} role="switch" aria-checked={compare}>
          Compare data <span className={compare ? "switch on" : "switch"} />
        </Link>
      </div>

      <div className="kpis six">
        {kpis.map((k) => {
          const delta = k.before == null ? null : change(k.now, k.before);
          return (
            <div className="kpi" key={k.label}>
              <div className="kpi-label">{k.label}</div>
              <div className="kpi-value">{k.value}</div>
              <div className="kpi-note">{k.note}</div>
              {k.before != null && (
                <div className="kpi-prev">
                  Before: {k.money ? fmtRs(k.before) : k.before}
                  {delta && <span className={delta.up ? "up" : "down"}> {delta.text}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="dash-split">
        <Card title="Gross sales by day" lede={`${long(from)} - ${long(to)}`} action={<More href={`/backoffice/reports/sales?${days}`}>Sales summary</More>}>
          <SalesChart cur={cur.days} prev={prev?.days ?? null} upto={cur.days.filter((d) => d.day <= now.today).length} />
          {prev && (
            <div className="legend">
              <span>
                <i />
                This period
              </span>
              <span>
                <i className="prev" />
                {long(data.prevFrom)} - {long(data.prevTo)}
              </span>
            </div>
          )}
        </Card>
        <Card title="Top sellers" lede="By what they brought in, add-ons included" action={<More href={`/backoffice/reports/items?${days}`}>Item sales</More>}>
          {cur.top.length === 0 ? (
            <p className="dash-empty">Nothing sold in these days.</p>
          ) : (
            <ul className="rank">
              {cur.top.map((r, i) => (
                <li key={r.name}>
                  <div className="rank-row">
                    <em>{i + 1}</em>
                    <b>{r.name}</b>
                    <strong>{fmtRs(r.amount)}</strong>
                  </div>
                  <span className="bar">
                    <i style={{ width: `${Math.max(0, (r.amount / itemsTop) * 100)}%` }} />
                  </span>
                  <small>
                    {fmtQty(r.qty)} sold{r.cat ? ` · ${r.cat}` : ""}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid-3 even">
        <Card title="Payment methods" lede="How the money came in">
          <Shares rows={cur.payments} total={cur.gross} none="Unknown" />
        </Card>
        <Card title="Order types" lede="Tables, takeaway, delivery, counter">
          <Shares rows={cur.dining} total={cur.gross} none="Not set" />
        </Card>
        <Card title="Categories" lede="Menu prices, before discounts" action={<More href={`/backoffice/reports/items?${days}&group=category`}>All</More>}>
          <Shares rows={cur.cats.map((r) => ({ name: r.name, n: 0, amount: r.amount }))} total={catsTotal} none="No category" count={false} />
        </Card>
      </div>

      <div className="dash-split">
        <Card
          title="Sales by hour"
          lede={peak.amount > 0 ? `Busiest from ${hh(peak.hour)} to ${hh(peak.hour + 1)}: ${fmtRs(peak.amount)} on ${plural(peak.n, "receipt", "receipts")}` : "When the money comes in"}
        >
          {hours.length === 0 ? (
            <p className="dash-empty">Nothing sold in these days.</p>
          ) : (
            <div className="hours" role="img" aria-label="Sales by hour of the day">
              {hours.map((h) => (
                <div key={h.hour} title={`${hh(h.hour)}: ${fmtRs(h.amount)} on ${plural(h.n, "receipt", "receipts")}`}>
                  <i className={h.hour === peak.hour ? "peak" : undefined} style={{ height: `calc((100% - 24px) * ${peak.amount > 0 ? Math.max(0, h.amount / peak.amount).toFixed(3) : 0})` }} />
                  <span>{String(h.hour).padStart(2, "0")}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Staff" lede="Who took the payments">
          <Shares rows={cur.staff} total={cur.gross} none="Not recorded" />
        </Card>
      </div>

      <Card title="Latest receipts" lede="The last six, whatever days are picked" action={<More href="/backoffice/receipts">All receipts</More>} flush>
        {data.recent.length === 0 ? (
          <p className="dash-empty">No receipts yet. They appear here as the tills sync.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>When</th>
                <th>Order</th>
                <th>Staff</th>
                <th>Paid by</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.number}>
                  <td className="strong">
                    {r.number} {r.type === "refund" && <span className="badge red">Refund</span>}
                  </td>
                  <td>{at(r.at)}</td>
                  <td>{r.tbl ? `Table ${r.tbl}` : [r.order_no, r.order_name].filter(Boolean).join(" · ") || <span className="muted">Direct sale</span>}</td>
                  <td>{r.staff ?? <span className="muted">Not recorded</span>}</td>
                  <td>{r.paid_by ?? ""}</td>
                  <td className="num strong">{fmtRs(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
