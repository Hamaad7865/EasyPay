import Link from "next/link";
import { ArrowRight, TabletSmartphone } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money, withDefaults } from "@/lib/settings";
import { basics, clock, today } from "@/lib/report";
import { FRESH_MINUTES, STATE_BADGE, TILLS, type Till, ago, expectedCash, span, stateLine, tillState } from "@/lib/pos";
import { Empty, PageHead } from "../../ui";
import { Stat } from "../../reports/parts";

// Every till of the restaurant: when it was last heard from, the day open on
// it, and what it has done today. The back office hears from a till when it
// syncs: each sale as it is made, and about every 15 minutes while someone is
// at it. A till left alone stops asking after half an hour and syncs again at
// the next touch. So this page says when a till last synced, never that it is
// "online", and never that a silent one is in trouble: it cannot know.
export default async function Tills() {
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    const rows = (await c.query(TILLS, [ctx.tenantId, today(b.tz)])).rows as Till[];
    return { tz: b.tz, ok: b.ok, s: withDefaults(b.settings), rows };
  });
  const now = new Date();
  const at = clock(d.tz);
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const tills = d.rows.map((t) => {
    const seen = t.seen ? new Date(t.seen) : null;
    return { ...t, seenAt: seen, state: tillState(seen, now, t.off) };
  });
  const active = tills.filter((t) => !t.off);
  const fresh = active.filter((t) => t.state === "ok");
  const open = active.filter((t) => t.shift_id !== null);
  const newest = Math.max(0, ...active.map((t) => t.till_version ?? 0));
  const when = (v: string | null) => (v ? `${ago(new Date(v), now)} · ${at(v)}` : "Not yet");

  return (
    <div>
      <PageHead
        title="Tills"
        lede="Every till set up for this restaurant: when it last synced, the day open on it, and what it has done today. A till syncs each sale as it is made, and checks in about every 15 minutes while someone is using it. Left untouched for half an hour it stops asking, and syncs again at the next touch: a till that has said nothing for a while is one no one is at, or a tablet that is off."
      />
      {tills.length === 0 ? (
        <Empty icon={TabletSmartphone} title="No till is set up yet">Sign in on a tablet with the EasyPay app to set it up as a till. It shows here as soon as it has.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Tills" value={String(active.length)} note={tills.length > active.length ? `and ${tills.length - active.length} deactivated` : undefined} />
            <Stat label={`Synced in the last ${FRESH_MINUTES} minutes`} value={`${fresh.length} of ${active.length}`} />
            <Stat label="Days open now" value={String(open.length)} note={open.length > 0 ? open.map((t) => t.name).join(", ") : "No till has its day open"} />
            {d.ok ? (
              <Stat label="Sales today" value={m(active.reduce((a, t) => a + Number(t.gross) - Number(t.refunded), 0))} note={`${active.reduce((a, t) => a + t.sales, 0)} receipts, as of each till's last sync`} />
            ) : (
              <Stat label="Receipts today" value={String(active.reduce((a, t) => a + t.sales, 0))} note="as of each till's last sync" />
            )}
          </div>

          {tills.map((t) => {
            const expected = expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out);
            const behind = !t.off && t.till_version !== null && t.till_version < newest;
            return (
              <section key={t.id} className="card flush">
                <div className="card-head">
                  <div>
                    <h2>{t.name} <span className="muted" style={{ fontWeight: 400 }}>· {t.code} · {t.store}</span></h2>
                    <p>Set up {at(t.created_at)}</p>
                  </div>
                  <span className="row-actions">
                    {!t.off && <span className={"badge " + (t.shift_id ? "blue" : "")}>{t.shift_id ? "Day open" : "Day closed"}</span>}
                    <span className={"badge " + STATE_BADGE[t.state]}>{stateLine(t.state, t.seenAt, now)}</span>
                  </span>
                </div>
                <div className="card-body">
                  <div className="grid-3">
                    <div>
                      <h3>Sync</h3>
                      <dl className="kv">
                        <dt>Last synced</dt><dd>{t.seenAt ? when(t.seen) : "Not yet"}</dd>
                        <dt>Sent what it had</dt><dd>{when(t.last_push_at)}</dd>
                        <dt>Fetched changes</dt><dd>{when(t.last_pull_at)}</dd>
                        <dt>App build</dt>
                        <dd>
                          {t.till_version === null ? (t.app_version ?? "Not said yet") : `Build ${t.till_version}`}
                          {behind && <span className="badge amber" style={{ marginLeft: 8 }}>Older than build {newest}</span>}
                        </dd>
                      </dl>
                      {t.before_times && t.seenAt && !t.off && (
                        <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>From before sync times were kept: the last thing it sent, or its set-up. They fill in the next time it syncs.</p>
                      )}
                    </div>
                    <div>
                      <h3>Day</h3>
                      {t.shift_id ? (
                        <>
                          <dl className="kv">
                            <dt>Opened</dt><dd>{at(t.opened_at)}</dd>
                            {t.opened_by && (<><dt>By</dt><dd>{t.opened_by}</dd></>)}
                            {d.ok && (
                              <>
                                <dt>Opening float</dt><dd>{m(t.opening_float)}</dd>
                                <dt>Cash taken</dt><dd>{m(t.cash_taken)}</dd>
                                <dt>Cash in</dt><dd>{m(t.cash_in)}</dd>
                                <dt>Cash out</dt><dd>-{m(t.cash_out)}</dd>
                                <dt className="total">Expected in drawer</dt><dd className="total">{m(expected)}</dd>
                              </>
                            )}
                          </dl>
                          {d.ok && <Link className="card-link" style={{ marginTop: 10 }} href={`/backoffice/pos/cash?till=${t.id}`}>Cash flow <ArrowRight aria-hidden="true" /></Link>}
                        </>
                      ) : (
                        <>
                          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                            {t.off ? "This till was deactivated." : "No day is open on this till. A day is opened on the till, by counting the cash in its drawer."}
                          </p>
                          {t.last_closed_at && (
                            <dl className="kv" style={{ marginTop: 10 }}>
                              <dt>Last closed</dt><dd>{at(t.last_closed_at)}</dd>
                              <dt>Day closing</dt><dd>No. {t.last_close_no}</dd>
                            </dl>
                          )}
                          {d.ok && t.last_closed_at && <Link className="card-link" style={{ marginTop: 10 }} href="/backoffice/reports/day-close">Day closing <ArrowRight aria-hidden="true" /></Link>}
                        </>
                      )}
                    </div>
                    <div>
                      <h3>Today</h3>
                      <dl className="kv">
                        <dt>Receipts</dt><dd>{t.sales}</dd>
                        {d.ok && (
                          <>
                            <dt>Sales</dt><dd>{m(t.gross)}</dd>
                            <dt>Refunds ({t.refunds})</dt><dd>-{m(t.refunded)}</dd>
                          </>
                        )}
                        <dt>Last receipt</dt><dd>{t.last_number ?? "None yet"}</dd>
                        {t.last_at && (<><dt>Rung up</dt><dd>{at(t.last_at)}</dd></>)}
                        <dt>Sent late</dt>
                        <dd>{t.late === 0 ? "None" : <span className="badge amber">{t.late}, slowest {span(t.worst_late)}</span>}</dd>
                        <dt>App stopped, 7 days</dt>
                        <dd>{t.crashes === 0 ? "Never" : <span className="badge red">{t.crashes} {t.crashes === 1 ? "time" : "times"}</span>}</dd>
                      </dl>
                      <Link className="card-link" style={{ marginTop: 10 }} href={`/backoffice/pos/activity?till=${t.id}`}>Activity <ArrowRight aria-hidden="true" /></Link>
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
          <p className="muted" style={{ fontSize: 12.5 }}>
            Figures are as of each till&apos;s last sync. A sale counts as late when it reached the server more than two minutes after the till rang it up: the till was offline then, and sent it when its network came back.
          </p>
        </>
      )}
    </div>
  );
}
