import { Clock } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { filters, fmtDay, reportStart } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters, Stat } from "../parts";

// A spell at work is a clock-in and the clock-out that follows it. The till
// records each punch as a row of its own and never changes one, so the spells
// are put together here:
//   - a clock-in followed by a clock-out is a spell, with its hours;
//   - a clock-in followed by another clock-in was never clocked out: it is
//     shown without hours, so nobody is paid for a guess;
//   - a clock-in with nothing after it is someone still at work;
//   - a spell belongs to the day it started on, in the store's time zone, so
//     a night that runs past midnight stays in one piece.
// $1 tenant, $2 from day, $3 to day, $4 employee or null.
const SPELLS = `
  with p as (
    select tp.employee_id, tp.kind, tp.device_time as at, s.timezone,
           lead(tp.kind) over w as next_kind, lead(tp.device_time) over w as next_at
      from timeclock_punches tp join stores s on s.tenant_id = tp.tenant_id and s.id = tp.store_id
     where tp.tenant_id = $1 and tp.deleted_at is null
    window w as (partition by tp.employee_id order by tp.device_time, tp.id)
  )
  select p.employee_id, e.name,
         (p.at at time zone p.timezone)::date::text as day,
         to_char(p.at at time zone p.timezone, 'HH24:MI') as clock_in,
         case when p.next_kind = 'out' then to_char(p.next_at at time zone p.timezone, 'HH24:MI') end as clock_out,
         case when p.next_kind = 'out' and (p.next_at at time zone p.timezone)::date <> (p.at at time zone p.timezone)::date
              then (p.next_at at time zone p.timezone)::date::text end as out_day,
         case when p.next_kind = 'out' then greatest(0, round(extract(epoch from p.next_at - p.at) / 60))::int end as minutes,
         p.next_kind is null as working
    from p left join employees e on e.tenant_id = $1 and e.id = p.employee_id
   where p.kind = 'in'
     and (p.at at time zone p.timezone)::date between $2::date and $3::date
     and ($4::uuid is null or p.employee_id = $4::uuid)
   order by e.name, p.at`;

type Spell = { employee_id: string; name: string | null; day: string; clock_in: string; clock_out: string | null; out_day: string | null; minutes: number | null; working: boolean };

const hours = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
// hours as a number, for pay: 7 h 30 is 7.50
const decimal = (min: number) => (min / 60).toFixed(2);

export default async function TimeCards({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    // a week is the usual question; one day would hide most of it
    const f = filters(sp, l.tz);
    if (!sp.from && !sp.to) {
      const start = new Date(f.to + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - 6);
      f.from = start.toISOString().slice(0, 10);
    }
    if (!ok) return { l, f, ok: false as const };
    return { l, f, ok: true as const, spells: (await c.query(SPELLS, [ctx.tenantId, f.from, f.to, f.employee])).rows as Spell[] };
  });
  const head = <PageHead title="Time cards" lede="Who clocked in and out on the tills, and the hours between. A spell counts for the day it started on. A clock-in that was never clocked out shows no hours." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;

  const people = new Map<string, { name: string; spells: Spell[] }>();
  for (const s of d.spells) {
    const p = people.get(s.employee_id) ?? { name: s.name ?? "Someone who was removed", spells: [] };
    p.spells.push(s);
    people.set(s.employee_id, p);
  }
  const total = d.spells.reduce((a, s) => a + (s.minutes ?? 0), 0);
  const open = d.spells.filter((s) => s.working).length;
  const missing = d.spells.filter((s) => s.minutes === null && !s.working).length;
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/timecards" f={d.f} l={d.l} show={["employee"]} />
      {d.spells.length === 0 ? (
        <Empty icon={Clock} title="Nobody clocked in on these days">Pick other dates. Staff clock in and out on the till, with their PIN.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Hours worked" value={hours(total)} note={`${decimal(total)} hours`} />
            <Stat label="Staff" value={String(people.size)} note={`${d.spells.length} ${d.spells.length === 1 ? "spell" : "spells"}`} />
            <Stat label="At work now" value={String(open)} note={open === 0 ? "Everyone has clocked out" : "Clocked in and not out yet"} />
            <Stat label="No clock-out" value={String(missing)} note={missing === 0 ? "Every spell has both ends" : "Clocked in again without clocking out"} />
          </div>
          {[...people.entries()].map(([id, p]) => {
            const mins = p.spells.reduce((a, s) => a + (s.minutes ?? 0), 0);
            return (
              <section key={id} className="card flush">
                <div className="card-head">
                  <div>
                    <h2>{p.name}</h2>
                    <p>
                      {hours(mins)} over {p.spells.length} {p.spells.length === 1 ? "spell" : "spells"}
                    </p>
                  </div>
                  {p.spells.some((s) => s.working) && <span className="badge blue">At work now</span>}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Clocked in</th>
                      <th>Clocked out</th>
                      <th className="num">Time</th>
                      <th className="num">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.spells.map((s, i) => (
                      <tr key={i}>
                        <td>{fmtDay(s.day)}</td>
                        <td>{s.clock_in}</td>
                        <td>
                          {s.clock_out ? (
                            <>
                              {s.clock_out}
                              {s.out_day && <span className="muted"> ({fmtDay(s.out_day)})</span>}
                            </>
                          ) : s.working ? (
                            <span className="badge blue">Still at work</span>
                          ) : (
                            <span className="badge amber">No clock-out</span>
                          )}
                        </td>
                        <td className="num">{s.minutes === null ? "" : hours(s.minutes)}</td>
                        <td className="num strong">{s.minutes === null ? "" : decimal(s.minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td />
                      <td />
                      <td className="num">{hours(mins)}</td>
                      <td className="num">{decimal(mins)}</td>
                    </tr>
                  </tfoot>
                </table>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
