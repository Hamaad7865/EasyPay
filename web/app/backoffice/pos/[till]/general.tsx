import Link from "next/link";
import { type Mode, words } from "@/lib/mode";
import { money } from "@/lib/settings";
import { clock } from "@/lib/report";
import { EVENT, type Event, type Taken, type TillDay, ago, eventDetail, expectedCash, span, variance } from "@/lib/pos";
import { Card } from "../../ui";
import { Stat } from "../../reports/parts";
import type { Base } from "./types";

// General: what the till took today, its drawer, the last thing it did, its
// latest days, and how it has been syncing. Money is for a role that sees
// reports; without it the tab still says what the till is doing.
export function General({ d, mode, now }: { d: Base & { taken: Taken[]; days: TillDay[]; last: Event | null }; mode: Mode; now: Date }) {
  const { t } = d;
  const at = clock(d.tz);
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: d.tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const when = (v: string | null) => (v ? `${ago(new Date(v), now)} · ${at(v)}` : "Not yet");
  const taken = d.taken.reduce((a, x) => a + Number(x.amount), 0);
  const expected = expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out);
  const last = d.last;
  const said = last ? (d.ok ? eventDetail(last, m) : last.ref ?? "") : "";

  return (
    <div>
      <div className="stats three">
        {d.ok ? (
          <Stat label="Taken today on this till" value={m(taken)} note={d.taken.length > 0 ? d.taken.map((x) => `${x.name} ${m(x.amount)}`).join(" · ") : "No payments yet"} />
        ) : (
          <Stat label="Receipts today" value={String(t.sales)} note="as of the till's last sync" />
        )}
        {t.shift_id ? (
          <Stat
            label="Drawer"
            value={d.ok ? m(expected) : "Open"}
            note={`${d.ok ? "Expected in drawer · open" : "Open"} since ${at(t.opened_at)}${t.opened_by ? ` by ${t.opened_by}` : ""}`}
          />
        ) : (
          <Stat label="Drawer" value="Closed" note={t.off ? "This till was deactivated" : "A day is opened on the tablet"} />
        )}
        {last ? (
          <Stat label="Last activity" value={at(last.at)} note={(EVENT[last.kind]?.[0] ?? last.kind) + (said ? ` · ${said}` : "")} />
        ) : t.last_at ? (
          <Stat label="Last activity" value={at(t.last_at)} note={`Receipt ${t.last_number ?? ""}`} />
        ) : (
          <Stat label="Last activity" value="Nothing yet" note="No event recorded yet" />
        )}
      </div>

      <Card title="Latest days" lede="A day runs from the count that opens the drawer to the count that closes it." flush>
        {d.days.length === 0 ? (
          <div className="card-body">
            <p className="muted" style={{ margin: 0 }}>This till has not opened a day yet. A day is opened on the tablet, by counting the cash in its drawer.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Opened</th>
                <th>By</th>
                <th>Closed</th>
                {d.ok && <th className="num">In the drawer</th>}
                {d.ok && <th>Variance</th>}
              </tr>
            </thead>
            <tbody>
              {d.days.map((x) => {
                const v = variance(x.counted_cash, x.expected_cash);
                return (
                  <tr key={x.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{at(x.opened_at)}</td>
                    <td>{x.opened_by ?? ""}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {x.closed_at ? (
                        d.ok ? <Link href={`/backoffice/pos/${t.id}?tab=cash&ref=${dayOf.format(new Date(x.closed_at))}`}>{at(x.closed_at)}</Link> : at(x.closed_at)
                      ) : (
                        <span className="badge blue">Open</span>
                      )}
                    </td>
                    {d.ok && (
                      <td className="num strong">
                        {x.closed_at ? (x.counted_cash === null ? "Not counted" : m(x.counted_cash)) : m(expectedCash(x.opening_float, x.cash_taken, x.cash_in, x.cash_out))}
                      </td>
                    )}
                    {d.ok && <td>{x.closed_at ? v && <span className={"badge " + v.tone}>{v.off === 0 ? v.word : `${v.word} ${m(Math.abs(v.off))}`}</span> : <span className="muted">Expected now</span>}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Today">
          <dl className="kv">
            <dt>Receipts</dt>
            <dd>{t.sales}</dd>
            {d.ok && (
              <>
                <dt>Sales</dt>
                <dd>{m(t.gross)}</dd>
                <dt>Refunds ({t.refunds})</dt>
                <dd>-{m(t.refunded)}</dd>
              </>
            )}
            <dt>Last receipt</dt>
            <dd>{t.last_number ?? "None yet"}</dd>
            {t.last_at && (
              <>
                <dt>Rung up</dt>
                <dd>{at(t.last_at)}</dd>
              </>
            )}
          </dl>
        </Card>
        <Card title="Sync">
          <dl className="kv">
            <dt>Last synced</dt>
            <dd>{when(t.seen)}</dd>
            <dt>Sent what it had</dt>
            <dd>{when(t.last_push_at)}</dd>
            <dt>Fetched changes</dt>
            <dd>{when(t.last_pull_at)}</dd>
            <dt>Sent late today</dt>
            <dd>{t.late === 0 ? "None" : <span className="badge amber">{t.late}, slowest {span(t.worst_late)}</span>}</dd>
            <dt>App stopped, 7 days</dt>
            <dd>{t.crashes === 0 ? "Never" : <span className="badge red">{t.crashes} {t.crashes === 1 ? "time" : "times"}</span>}</dd>
          </dl>
          {t.before_times && t.seen && !t.off && (
            <p className="help">From before sync times were kept: the last thing it sent, or its set-up. They fill in the next time it syncs.</p>
          )}
        </Card>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Figures are as of the till&apos;s last sync. A sale counts as late when it reached the server more than two minutes after the till rang it up: the till had no network then, and sent it
        when it came back. This {words(mode).place}&apos;s other tills are under Point of sale.
      </p>
    </div>
  );
}
