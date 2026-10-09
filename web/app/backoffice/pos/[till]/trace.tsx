import {
  Activity, Banknote, CalendarCheck, Calculator, CircleDot, HandCoins, Inbox, LogIn, LogOut, type LucideIcon, ReceiptText, TriangleAlert, Undo2, Wallet,
} from "lucide-react";
import { money } from "@/lib/settings";
import { fmtDay } from "@/lib/report";
import { EVENT, type Event, LATE_SECONDS, byDay, eventDetail, isLate, span } from "@/lib/pos";
import { Go, Submit } from "../../busy";
import { Empty } from "../../ui";
import type { Base } from "./types";

// The round mark of each kind of event.
const ICON: Record<string, LucideIcon> = {
  sale: ReceiptText,
  refund: Undo2,
  cash_in: HandCoins,
  cash_out: Banknote,
  cash_drawer: Inbox,
  count: Calculator,
  open: Wallet,
  close: CalendarCheck,
  clock_in: LogIn,
  clock_out: LogOut,
  crash: TriangleAlert,
};

// Traceability, after Carfection's: everything the till did over a from-to
// range, newest first, under a band for each day. A round mark for each
// event, what it was, who did it, and its time large at the end of the line.
// A line that reached the server long after the till wrote it down says so:
// that is a till that was selling with no network.
export function Trace({ d, here, most }: { d: Base & { events: Event[] }; here: string; most: number }) {
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: d.tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const weekday = (day: string) => new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long" });
  const total = d.events[0]?.total ?? 0;
  const days = byDay(d.events, d.tz);
  const period = d.from === d.to ? fmtDay(d.from) : `${fmtDay(d.from)} to ${fmtDay(d.to)}`;

  return (
    <div>
      <Go className="filters" action={here}>
        <input type="hidden" name="tab" value="trace" />
        <label>
          From
          <input type="date" name="from" defaultValue={d.from} />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={d.to} />
        </label>
        <Submit>Show</Submit>
      </Go>

      {d.events.length === 0 ? (
        <Empty icon={Activity} title={`Nothing recorded, ${period}`}>This till sent nothing for that period. Pick other dates.</Empty>
      ) : (
        <>
          {total > d.events.length && (
            <div className="note">
              Showing the latest {most.toLocaleString("en-US")} of {total.toLocaleString("en-US")} events. Pick a shorter period to see the rest.
            </div>
          )}
          <div className="trace">
            {days.map((day) => (
              <section key={day.day}>
                <h3 className="trace-day">
                  <span>
                    {weekday(day.day)}, {fmtDay(day.day)}
                  </span>
                </h3>
                <ol>
                  {day.events.map((e, i) => {
                    const [label, tone] = EVENT[e.kind] ?? [e.kind, ""];
                    const Icon = ICON[e.kind] ?? CircleDot;
                    const detail = eventDetail(e, m);
                    return (
                      <li key={i}>
                        <span className={"trace-ico " + tone} aria-hidden="true">
                          <Icon strokeWidth={1.9} />
                        </span>
                        <span className="trace-what">
                          <b>{label}</b>
                          {(detail || e.who) && <span className="trace-detail">{[detail, e.who ? `by ${e.who}` : ""].filter(Boolean).join(" · ")}</span>}
                          {isLate(e.late) ? (
                            <span className="badge amber">Reached the server {span(e.late!)} later</span>
                          ) : e.late !== null && e.late < -LATE_SECONDS ? (
                            <span className="badge">The till&apos;s clock is {span(-e.late)} ahead</span>
                          ) : null}
                        </span>
                        <time dateTime={e.at}>{time.format(new Date(e.at))}</time>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Times are the till&apos;s own. A till sends each thing as it happens; one that arrived more than two minutes later was made while the till had no network, and was sent when it came
            back.
          </p>
        </>
      )}
    </div>
  );
}
