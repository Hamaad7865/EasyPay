import Link from "next/link";
import type { PoolClient } from "pg";
import { Lightbulb } from "lucide-react";
import { RECEIPTS, today } from "@/lib/report";
import { one } from "../ui";

// What the three Insights pages share. They read the same receipts the
// reports read (RECEIPTS), over the last 7, 30 or 90 days, and set them
// beside the same number of days just before.

export type Period = { days: number; from: string; to: string; prevFrom: string; prevTo: string };
const SPANS = [7, 30, 90];

const shift = (day: string, by: number) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

// The days end today, on the restaurant's own calendar.
export function period(sp: Record<string, string | string[] | undefined>, tz: string): Period {
  const asked = Number(one(sp.days));
  const days = SPANS.includes(asked) ? asked : 30;
  const to = today(tz);
  const from = shift(to, -(days - 1));
  return { days, from, to, prevFrom: shift(from, -days), prevTo: shift(from, -1) };
}

// RECEIPTS' arguments for everyone, every order type, sales and refunds.
export const range = (tenantId: string, from: string, to: string) => [tenantId, from, to, null, null, "all"];

export type Totals = { net: number; orders: number; covers: number; seated: number };

// The restaurant's totals for some days. An order is an account: a bill split
// in three is one order. Sales with no order behind them count one each.
export async function totals(c: PoolClient, tenantId: string, from: string, to: string): Promise<Totals> {
  const r = (
    await c.query(
      `with r as (${RECEIPTS})
       select coalesce(sum(signed_total), 0)::float8 as net,
              count(distinct ticket_id) filter (where type = 'sale')::int as accounts,
              count(*) filter (where type = 'sale' and ticket_id is null)::int as loose,
              -- what the orders that say how many guests they were came to
              coalesce(sum(signed_total) filter (where covers > 0), 0)::float8 as seated,
              (select coalesce(sum(z.covers), 0)::int
                 from (select distinct on (ticket_id) ticket_id, covers from r where type = 'sale' and ticket_id is not null) z) as covers
         from r`,
      range(tenantId, from, to),
    )
  ).rows[0] as { net: number; accounts: number; loose: number; seated: number; covers: number };
  return { net: r.net, orders: r.accounts + r.loose, covers: r.covers, seated: r.seated };
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const longDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
const shortDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
export const per = (amount: number, by: number) => (by > 0 ? amount / by : 0);

// How much something moved, as a share of where it was. Null when there is
// nothing before to compare with.
export const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);
export const pct = (share: number) => {
  const v = Math.abs(share * 100);
  return `${v >= 10 || v < 0.05 ? Math.round(v) : v.toFixed(1)}%`;
};

// The chip beside a figure: up or down on what it is set against. With
// nothing to set it against there is no chip, unless the caller has a word
// for that (an item that was not sold before is "New").
export function Delta({ now, before, fresh }: { now: number; before: number; fresh?: string }) {
  const c = change(now, before);
  if (c === null) return fresh && now > 0 ? <i className="delta up">{fresh}</i> : null;
  if (Math.abs(c) < 0.005) return <i className="delta flat">No change</i>;
  return <i className={"delta " + (c > 0 ? "up" : "down")}>{(c > 0 ? "+" : "−") + pct(c)}</i>;
}

// The last 7, 30 or 90 days.
export function SpanPicker({ path, p }: { path: string; p: Period }) {
  return (
    <div className="bo-chips insight-spans">
      {SPANS.map((n) => (
        <Link key={n} href={`${path}?days=${n}`} className={n === p.days ? "on" : undefined}>
          Last {n} days
        </Link>
      ))}
      <span>
        {shortDay(p.from)} to {shortDay(p.to)}, set beside {shortDay(p.prevFrom)} to {shortDay(p.prevTo)}
      </span>
    </div>
  );
}

// One figure with how it moved. `none` is what to say when the days before
// hold nothing to set it against.
export function Figure({ label, value, now, before, note, none }: { label: string; value: string; now?: number; before?: number; note?: string; none?: string }) {
  const compared = now !== undefined && before !== undefined;
  const nothingBefore = compared && change(now, before) === null;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">
        {compared && <Delta now={now} before={before} />} {nothingBefore && none ? none : note}
      </div>
    </div>
  );
}

// The page's findings in words, each worked out from the figures under it.
export function Standouts({ lines }: { lines: React.ReactNode[] }) {
  const said = lines.filter(Boolean);
  if (!said.length) return null;
  return (
    <section className="standouts" aria-label="What stands out">
      <h2>
        <Lightbulb aria-hidden="true" />
        What stands out
      </h2>
      <ul>
        {said.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
