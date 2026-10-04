import Link from "next/link";
import type { PoolClient } from "pg";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { fmtRs } from "@/lib/money";

type Day = { day: string; gross: number };
type Sales = { accounts: number; gross: number; tax: number; days: Day[] };

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
const short = (s: string) => parse(s).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });

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
    { label: "This month", from: first, to: lastOfMonth(first) },
    { label: "Last month", from: prevFirst, to: lastOfMonth(prevFirst) },
  ];
}

// What counts, for every figure on this page:
//   - receipt_revenue rows that count as a sale (a double payment for goods
//     already sold is money to give back, not a sale);
//   - a refund subtracts: the view signs the total, the tax is signed here;
//   - the day is the day on the till's clock when the receipt was issued
//     (an offline sale that syncs the next morning still belongs to its own
//     day), in the store's time zone.
const SALES = `
  select (coalesce(v.device_time, v.created_at) at time zone s.timezone)::date as day,
         v.signed_total as total,
         case when v.type = 'refund' then -v.tax_total else v.tax_total end as tax,
         v.type, v.ticket_id
    from receipt_revenue v
    join stores s on s.tenant_id = v.tenant_id and s.id = v.store_id
   where v.tenant_id = $1 and v.counts_as_sale`;

async function loadSales(c: PoolClient, tenantId: string, from: string, to: string): Promise<Sales> {
  const days = await c.query(
    `with r as (${SALES})
     select d::date::text as day, coalesce(sum(r.total), 0)::text as gross, coalesce(sum(r.tax), 0)::text as tax
       from generate_series($2::date, $3::date, interval '1 day') d
       left join r on r.day = d::date
      group by d order by d`,
    [tenantId, from, to],
  );
  // an account is an order: a bill split into three receipts is one account
  const accounts = await c.query(
    `with r as (${SALES})
     select count(distinct ticket_id)::int as n from r where type = 'sale' and day between $2::date and $3::date`,
    [tenantId, from, to],
  );
  const rows = days.rows as { day: string; gross: string; tax: string }[];
  return {
    accounts: accounts.rows[0].n as number,
    gross: rows.reduce((a, r) => a + Number(r.gross), 0),
    tax: rows.reduce((a, r) => a + Number(r.tax), 0),
    days: rows.map((r) => ({ day: r.day, gross: Number(r.gross) })),
  };
}

function change(now: number, before: number) {
  if (before === 0) return now === 0 ? null : { text: "new", up: now > 0 };
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return { text: (pct > 0 ? "+" : "") + pct + "%", up: pct >= 0 };
}

function niceMax(rupees: number) {
  if (rupees <= 0) return 2000;
  const pow = 10 ** Math.floor(Math.log10(rupees));
  const f = rupees / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 8 ? 8 : 10) * pow;
}

function Chart({ cur, prev }: { cur: Day[]; prev: Day[] | null }) {
  const W = 1000, H = 300, L = 76, R = 16, T = 14, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const top = niceMax(Math.max(0, ...cur.map((d) => d.gross), ...(prev ?? []).map((d) => d.gross)) / 100);
  const n = cur.length;
  const x = (i: number) => (n === 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1));
  const y = (cents: number) => T + plotH - (Math.max(0, cents) / 100 / top) * plotH;
  const path = (days: Day[]) => days.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.gross).toFixed(1)}`).join(" ");
  const every = Math.ceil(n / 8);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gross sales by day">
      {[0, 1, 2, 3, 4].map((k) => {
        const yy = T + plotH - (k / 4) * plotH;
        return (
          <g key={k}>
            <line className="grid" x1={L} x2={W - R} y1={yy} y2={yy} />
            <text x={L - 10} y={yy + 4} textAnchor="end">
              {fmtRs(((top * k) / 4) * 100)}
            </text>
          </g>
        );
      })}
      {cur.map((d, i) =>
        i % every === 0 ? (
          <text key={d.day} x={x(i)} y={H - 10} textAnchor="middle">
            {short(d.day)}
          </text>
        ) : null,
      )}
      {prev && n > 1 && <path className="prev" d={path(prev.slice(0, n))} />}
      {n > 1 && <path className="area" d={`${path(cur)} L${x(n - 1).toFixed(1)},${T + plotH} L${x(0).toFixed(1)},${T + plotH} Z`} />}
      {n > 1 && <path className="line" d={path(cur)} />}
      {n <= 31 && cur.map((d, i) => (d.gross !== 0 || n === 1 ? <circle key={d.day} className="dot" cx={x(i)} cy={y(d.gross)} r={4} /> : null))}
    </svg>
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
  const data = await withTenant(ctx.tenantId, async (c) => {
    const base = await c.query(
      // flagged = still open: no recorded reason yet, or a reason not resolved.
      `select (now() at time zone coalesce(
                 (select s.timezone from stores s where s.tenant_id = $1 order by s.created_at limit 1),
                 'Indian/Mauritius'))::date::text as today,
              (select count(*)::int from receipts r
                where r.deleted_at is null and r.tenant_id = $1 and r.needs_review
                  and (not exists (select 1 from receipt_reviews v
                                    where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)
                    or exists (select 1 from receipt_reviews v
                                where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null
                                  and v.resolved_at is null))) as flagged`,
      [ctx.tenantId],
    );
    const today = base.rows[0].today as string;
    const options = presets(today);
    // default: this month. A range that is malformed, backwards or longer
    // than a year falls back to it.
    let { from, to } = options[3];
    if (isDay(sp.from) && isDay(sp.to) && sp.from <= sp.to && span(sp.from, sp.to) <= 366) {
      from = sp.from;
      to = sp.to;
    }
    const cur = await loadSales(c, ctx.tenantId, from, to);
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(span(from, to) - 1));
    const prev = compare ? await loadSales(c, ctx.tenantId, prevFrom, prevTo) : null;
    return { flagged: base.rows[0].flagged as number, options, from, to, cur, prev, prevFrom, prevTo };
  });
  const { from, to, cur, prev } = data;
  const href = (f: string, t: string, cmp: boolean) => `/backoffice?from=${f}&to=${t}${cmp ? "&compare=1" : ""}`;
  const kpis = [
    { label: "Closed accounts", value: String(cur.accounts), now: cur.accounts, before: prev?.accounts, money: false, note: "Orders paid in the period" },
    { label: "Total net sales", value: fmtRs(cur.gross - cur.tax), now: cur.gross - cur.tax, before: prev && prev.gross - prev.tax, money: true, note: "Gross sales less VAT" },
    { label: "Total taxes", value: fmtRs(cur.tax), now: cur.tax, before: prev?.tax, money: true, note: "VAT inside those sales" },
    { label: "Total gross sales", value: fmtRs(cur.gross), now: cur.gross, before: prev?.gross, money: true, note: "Paid by customers, after discounts and refunds" },
  ];
  return (
    <div>
      {data.flagged > 0 && (
        <div className="bo-banner warn">
          <strong>
            {data.flagged} {data.flagged === 1 ? "receipt needs" : "receipts need"} review.
          </strong>
          A till reported something that does not add up (a price that changed, a payment that was short or doubled).{" "}
          <Link href="/backoffice/receipts">Open receipts</Link>
        </div>
      )}
      <h1>Sales dashboard</h1>
      <div className="dash-controls">
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
      <div className="card">
        <div className="kpis">
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
        <h2>
          Gross sales for {long(from)} - {long(to)}
        </h2>
        <Chart cur={cur.days} prev={prev?.days ?? null} />
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
      </div>
    </div>
  );
}
