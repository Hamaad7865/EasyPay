import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money, withDefaults } from "@/lib/settings";
import { basics, RECEIPTS } from "@/lib/report";
import { Card, Empty, PageHead, type Search } from "../../ui";
import { Figure, SpanPicker, Standouts, WEEKDAYS, change, longDay, pct, per, period, range, totals } from "../parts";

// When the restaurant sells: which days of the week, which hours of the day,
// and how these days stand against the same number of days before. The total
// is the Sales summary's for the same days.

type Cell = { dow: number; hour: number; amount: number; n: number };
type DayRow = { day: string; amount: number };

export default async function SalesPatterns({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    // the time zone, the right to see reports and the settings, in one trip
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    const p = period(sp, b.tz);
    if (!b.ok) return { p, ok: false as const };
    const q = async <T,>(sql: string) => (await c.query(`with r as (${RECEIPTS}) ${sql}`, range(ctx.tenantId, p.from, p.to))).rows as T[];
    return {
      p,
      ok: true as const,
      s: withDefaults(b.settings),
      now: await totals(c, ctx.tenantId, p.from, p.to),
      before: await totals(c, ctx.tenantId, p.prevFrom, p.prevTo),
      // the weekday and the hour are the restaurant's own, not the server's
      cells: await q<Cell>(
        `select extract(isodow from day)::int as dow, extract(hour from (at at time zone timezone))::int as hour,
                sum(signed_total)::float8 as amount, count(*) filter (where type = 'sale')::int as n
           from r group by 1, 2`,
      ),
      days: await q<DayRow>(`select day::text, sum(signed_total)::float8 as amount from r group by day order by day`),
    };
  });

  const head = (
    <PageHead title="Sales patterns" lede="When you sell: the days of the week and the hours of the day that bring the money in, and how these days stand against the ones before." />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const { p, now, before } = d;
  const m = (v: number) => money(Math.round(v), d.s.decimals);
  const picker = <SpanPicker path="/backoffice/insights/sales" p={p} />;
  if (!d.cells.length) {
    return (
      <div>
        {head}
        {picker}
        <Empty icon={CalendarRange} title="No sales in these days">
          <p>Once the till has taken payments, the busy days and hours show here.</p>
        </Empty>
      </div>
    );
  }

  // how many Mondays, Tuesdays... the days hold, so a weekday is judged by its average
  const times = Array(8).fill(0) as number[];
  for (let t = new Date(p.from + "T00:00:00Z"), end = new Date(p.to + "T00:00:00Z"); t <= end; t.setUTCDate(t.getUTCDate() + 1)) times[t.getUTCDay() || 7]++;
  const byDow = Array(8).fill(0) as number[];
  const byHour = Array(24).fill(0) as number[];
  for (const c of d.cells) {
    byDow[c.dow] += c.amount;
    byHour[c.hour] += c.amount;
  }
  const week = WEEKDAYS.map((name, i) => ({ name, times: times[i + 1], total: byDow[i + 1], avg: per(byDow[i + 1], times[i + 1]) })).filter((w) => w.times > 0);
  const busiest = week.reduce((a, b) => (b.avg > a.avg ? b : a));
  const quietest = week.reduce((a, b) => (b.avg < a.avg ? b : a));
  const normalDay = per(now.net, p.days);
  const topAvg = Math.max(...week.map((w) => w.avg), 1);

  // the hours the heat map shows: from the first with a sale to the last
  const sold = d.cells.map((c) => c.hour);
  const hours = Array.from({ length: Math.max(...sold) - Math.min(...sold) + 1 }, (_, i) => Math.min(...sold) + i);
  const cell = new Map(d.cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const avgAt = (dow: number, hour: number) => per(cell.get(`${dow}-${hour}`)?.amount ?? 0, times[dow]);
  const hottest = Math.max(...d.cells.map((c) => avgAt(c.dow, c.hour)), 1);
  // the two hours in a row that bring the most
  let peak = hours[0];
  for (const h of hours) if (byHour[h] + (byHour[h + 1] ?? 0) > byHour[peak] + (byHour[peak + 1] ?? 0)) peak = h;
  const peakShare = per(byHour[peak] + (byHour[peak + 1] ?? 0), now.net);
  const best = d.days.reduce((a, b) => (b.amount > a.amount ? b : a));
  const moved = change(now.net, before.net);
  const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

  return (
    <div>
      {head}
      {picker}
      <div className="stats">
        <Figure label="Net sales" value={m(now.net)} now={now.net} before={before.net} note={`on the ${p.days} days before`} none={`No sales in the ${p.days} days before`} />
        <Figure label="Orders" value={now.orders.toLocaleString("en-US")} now={now.orders} before={before.orders} note={`${per(now.orders, p.days).toFixed(1)} a day`} />
        <Figure label="Average check" value={m(per(now.net, now.orders))} now={per(now.net, now.orders)} before={per(before.net, before.orders)} note="per order" />
        {now.covers > 0 ? (
          <Figure label="Sales per guest" value={m(per(now.seated, now.covers))} now={per(now.seated, now.covers)} before={per(before.seated, before.covers)} note={`${now.covers.toLocaleString("en-US")} guests counted`} />
        ) : (
          <Figure label="Best day" value={m(best.amount)} note={longDay(best.day)} />
        )}
      </div>

      <Standouts
        lines={[
          week.length > 1 && busiest.avg > 0 && (
            <>
              <b>{busiest.name}</b> is your busiest day: {m(busiest.avg)} on an average {busiest.name}
              {normalDay > 0 && busiest.avg > normalDay && `, ${pct(busiest.avg / normalDay - 1)} above an average day`}.
            </>
          ),
          peakShare > 0 && (
            <>
              <b>
                {hh(peak)} to {hh(peak + 2)}
              </b>{" "}
              brings in {pct(peakShare)} of the sales.
            </>
          ),
          week.length > 1 && quietest.name !== busiest.name && (
            <>{quietest.avg > 0 ? <><b>{quietest.name}</b> is the quietest: {m(quietest.avg)} on average.</> : <>Nothing was sold on a <b>{quietest.name}</b> in these days.</>}</>
          ),
          moved !== null ? (
            <>
              Sales are <b>{Math.abs(moved) < 0.005 ? "level with" : `${moved > 0 ? "up" : "down"} ${pct(moved)} on`}</b> the {p.days} days before ({m(now.net)} against {m(before.net)}).
            </>
          ) : (
            <>There were no sales in the {p.days} days before to compare with.</>
          ),
          <>
            Best single day: <b>{longDay(best.day)}</b>, {m(best.amount)}.
          </>,
        ]}
      />

      <Card title="Busy hours" lede="Average sales in each hour of each day of the week. Darker is busier.">
        <div className="heat-wrap">
          <div className="heat" style={{ "--cols": hours.length } as React.CSSProperties}>
            <span />
            {hours.map((h) => (
              <span key={h} className="heat-hour">
                {String(h).padStart(2, "0")}
              </span>
            ))}
            {WEEKDAYS.map((name, i) =>
              times[i + 1] === 0 ? null : (
                <div key={name} className="heat-row">
                  <span className="heat-day">{name.slice(0, 3)}</span>
                  {hours.map((h) => {
                    const v = avgAt(i + 1, h);
                    const n = cell.get(`${i + 1}-${h}`)?.n ?? 0;
                    const text = `${name} ${hh(h)}: ${v > 0 ? `${m(v)} on average, ${n} ${n === 1 ? "receipt" : "receipts"} in all` : "no sales"}`;
                    return <i key={h} className={`h${v > 0 ? Math.max(1, Math.ceil((v / hottest) * 5)) : 0}`} role="img" title={text} aria-label={text} />;
                  })}
                </div>
              ),
            )}
          </div>
        </div>
        <div className="heat-key" aria-hidden="true">
          Quieter <i className="h1" /> <i className="h2" /> <i className="h3" /> <i className="h4" /> <i className="h5" /> Busier
        </div>
      </Card>

      <Card
        title="Days of the week"
        lede="What an average Monday, Tuesday... brings, and its share of the sales"
        action={
          <Link href={`/backoffice/reports/sales?from=${p.from}&to=${p.to}`} className="card-link">
            Sales summary
          </Link>
        }
        flush
      >
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Days counted</th>
              <th className="num">Total</th>
              <th className="num">Average</th>
              <th>Against the busiest</th>
              <th className="num">Share of sales</th>
            </tr>
          </thead>
          <tbody>
            {week.map((w) => (
              <tr key={w.name}>
                <td className="strong">{w.name}</td>
                <td className="num">{w.times}</td>
                <td className="num">{m(w.total)}</td>
                <td className="num">{m(w.avg)}</td>
                <td>
                  <span className="bar">
                    <i style={{ width: `${Math.max(0, (w.avg / topAvg) * 100)}%` }} />
                  </span>
                </td>
                <td className="num">{now.net > 0 ? pct(w.total / now.net) : "0%"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>All days</td>
              <td className="num">{p.days}</td>
              <td className="num">{m(now.net)}</td>
              <td className="num">{m(normalDay)}</td>
              <td />
              <td className="num">100%</td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}
