import Link from "next/link";
import { ArrowRight, ChevronRight, TabletSmartphone } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { words } from "@/lib/mode";
import { money, withDefaults } from "@/lib/settings";
import { basics, clock, today } from "@/lib/report";
import { ASKED, type Asked, CASH_UPS, type CashUp, FRESH_MINUTES, MAY_ASK, TILLS, type Till, expectedCash, stateLine, takesRequests, tillState, variance } from "@/lib/pos";
import { Wait } from "../busy";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";
import { Stat } from "../reports/parts";
import { askClose } from "./actions";
import { CloseDayKey } from "./ask";

// Point of sale: every till of the business as a card, and behind each card
// the till's own page (pos/[till]). Under the cards, the days that were
// closed lately, with what each drawer should have held against what was
// counted in it.
//
// The back office hears from a till when it syncs: each sale as it is made,
// and about every 15 minutes while someone is at it. A till left alone stops
// asking after half an hour and syncs again at the next touch. So a card says
// when its till last synced, never that it is "online", and never that a
// silent one is in trouble: it cannot know.
export default async function PointOfSale({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    const [tills, ups, may, waiting] = await Promise.all([
      c.query(TILLS, [ctx.tenantId, today(b.tz)]),
      b.ok ? c.query(CASH_UPS, [ctx.tenantId, 10]) : Promise.resolve({ rows: [] }),
      c.query(MAY_ASK, [ctx.employeeId]),
      c.query(ASKED, [ctx.tenantId, null, true, 100]),
    ]);
    return {
      tz: b.tz, ok: b.ok, s: withDefaults(b.settings), rows: tills.rows as Till[], ups: ups.rows as CashUp[],
      mayClose: Boolean(may.rows[0]?.close), waiting: waiting.rows as Asked[],
    };
  });
  const w = words(ctx.mode);
  const now = new Date();
  const at = clock(d.tz);
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: d.tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const tills = d.rows.map((t) => {
    const seen = t.seen ? new Date(t.seen) : null;
    const state = tillState(seen, now, t.off);
    return { ...t, state, line: stateLine(state, seen, now) };
  });
  const active = tills.filter((t) => !t.off);
  const off = tills.filter((t) => t.off);
  const open = active.filter((t) => t.shift_id !== null);
  const fresh = active.filter((t) => t.state === "ok");
  const newest = Math.max(0, ...active.map((t) => t.till_version ?? 0));

  const card = (t: (typeof tills)[number]) => {
    const moved = [
      `incl. ${m(t.opening_float)} float`,
      ...(Number(t.cash_in ?? 0) !== 0 ? [`${m(t.cash_in)} put in`] : []),
      ...(Number(t.cash_out ?? 0) !== 0 ? [`${m(t.cash_out)} paid out`] : []),
    ];
    const build = t.till_version === null ? t.app_version : `Build ${t.till_version}`;
    // a closing asked of this till from here, which it has not carried out yet
    const closing = d.waiting.find((q) => q.device_id === t.id && q.kind === "close_day");
    const expected = expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out);
    return (
      // the card is one link into the till; the key to close its day sits over it, and is no part of the link
      <div key={t.id} className="till-wrap">
      <Link href={`/backoffice/pos/${t.id}`} className={"till" + (t.off ? " off" : "")}>
        <span className="till-top">
          <span className="till-ico" aria-hidden="true">
            <TabletSmartphone strokeWidth={1.9} />
          </span>
          <span className="till-who">
            <strong>{t.name}</strong>
            <span className="till-sync">
              <i className={"dot" + (t.state === "ok" ? " on" : "")} aria-hidden="true" />
              {t.line}
            </span>
            <span className="till-facts">
              <span>{t.store}</span>
              <span>{t.code}</span>
              {build && <span>{build}</span>}
              {!t.off && t.till_version !== null && t.till_version < newest && <span className="badge amber">Older than build {newest}</span>}
            </span>
          </span>
          <span className="till-go" aria-hidden="true">
            <ChevronRight />
          </span>
          <Wait />
        </span>
        {t.off ? (
          <span className="till-day">
            <span className="till-quiet">Deactivated. Open it to reactivate it.</span>
          </span>
        ) : t.shift_id ? (
          <span className="till-day cols">
            <span>
              <small>Day open</small>
              <b>{at(t.opened_at)}</b>
              {t.opened_by && <em>by {t.opened_by}</em>}
            </span>
            {d.ok && (
              <span>
                <small>Cash collected</small>
                <b>{m(t.cash_taken)}</b>
              </span>
            )}
            {d.ok && (
              <span>
                <small>Expected in drawer</small>
                <b>{m(expected)}</b>
                <em>{moved.join(" · ")}</em>
              </span>
            )}
            {closing && (
              <span className="till-asked">
                Closing asked {at(closing.requested_at)}
                {closing.who ? ` by ${closing.who}` : ""}: the till closes its day the next time it syncs.
              </span>
            )}
          </span>
        ) : (
          <span className="till-day">
            <span className="till-quiet">
              Day closed. A day is opened on the tablet.{t.last_closed_at ? ` Last closed ${at(t.last_closed_at)}.` : ""}
            </span>
          </span>
        )}
      </Link>
      {t.shift_id && d.mayClose && takesRequests(t) && !closing && (
        <CloseDayKey round action={askClose} till={t.id} name={t.name} expected={d.ok ? m(expected) : null} back="/backoffice/pos" />
      )}
      </div>
    );
  };

  return (
    <div>
      <PageHead
        title="Point of sale"
        lede={`Every till of this ${w.place}. Open one for what it took today, its settings, its cash flow and everything it did. A till syncs each sale as it is made and checks in about every 15 minutes while someone is using it; left untouched for half an hour it stops asking, so a till that has said nothing for a while is one no one is at, or a tablet that is off.`}
      />
      <Flash sp={sp} />
      {tills.length === 0 ? (
        <Empty icon={TabletSmartphone} title="No till is set up yet">Sign in on a tablet with the EasyPay app to set it up as a till. It shows here as soon as it has.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Tills" value={String(active.length)} note={off.length > 0 ? `and ${off.length} deactivated` : undefined} />
            <Stat label={`Synced in the last ${FRESH_MINUTES} minutes`} value={`${fresh.length} of ${active.length}`} />
            <Stat label="Days open now" value={String(open.length)} note={open.length > 0 ? open.map((t) => t.name).join(", ") : "No till has its day open"} />
            {d.ok ? (
              <Stat label="Sales today" value={m(active.reduce((a, t) => a + Number(t.gross) - Number(t.refunded), 0))} note={`${active.reduce((a, t) => a + t.sales, 0)} receipts, as of each till's last sync`} />
            ) : (
              <Stat label="Receipts today" value={String(active.reduce((a, t) => a + t.sales, 0))} note="as of each till's last sync" />
            )}
          </div>

          {active.length > 0 && <div className="tills">{active.map(card)}</div>}

          {d.ok && (
            <Card
              title="Recent cash-ups"
              lede="The last days that were closed: what each drawer should have held, and what was counted in it."
              action={
                <Link className="card-link" href="/backoffice/reports/day-close">
                  Day closing <ArrowRight aria-hidden="true" />
                </Link>
              }
              flush
            >
              {d.ups.length === 0 ? (
                <div className="card-body">
                  <p className="muted" style={{ margin: 0 }}>No day has been closed yet. A day is closed on the till, by counting the cash in its drawer.</p>
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Opened</th>
                      <th>Closed</th>
                      <th>Till</th>
                      <th className="num">Expected</th>
                      <th className="num">Counted</th>
                      <th>Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.ups.map((u) => {
                      const v = variance(u.counted_cash, u.expected_cash);
                      return (
                        <tr key={u.id}>
                          <td style={{ whiteSpace: "nowrap" }}>{at(u.opened_at)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{at(u.closed_at)}</td>
                          <td className="strong">
                            {/* its Cash flow, on the date it was closed */}
                            <Link href={`/backoffice/pos/${u.device_id}?tab=cash&ref=${dayOf.format(new Date(u.closed_at))}`}>{u.till}</Link> <span className="muted">{u.code}</span>
                          </td>
                          <td className="num">{u.expected_cash === null ? "" : m(u.expected_cash)}</td>
                          <td className="num strong">{u.counted_cash === null ? "Not counted" : m(u.counted_cash)}</td>
                          <td>{v && <span className={"badge " + v.tone}>{v.off === 0 ? v.word : `${v.word} ${m(Math.abs(v.off))}`}</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          )}

          {off.length > 0 && (
            <>
              <h2 className="tills-head">Deactivated</h2>
              <div className="tills">{off.map(card)}</div>
            </>
          )}
          <p className="muted" style={{ fontSize: 12.5 }}>Figures are as of each till&apos;s last sync.</p>
        </>
      )}
    </div>
  );
}
