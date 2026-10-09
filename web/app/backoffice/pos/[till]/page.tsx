import Link from "next/link";
import { notFound } from "next/navigation";
import { TabletSmartphone } from "lucide-react";
import { Refused, UUID, act } from "@/lib/action";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { isDay } from "@/lib/day";
import { money, withDefaults } from "@/lib/settings";
import { basics, clock, today } from "@/lib/report";
import {
  ACTIVITY, ASKED, type Asked, CLOSURES, type Closure, DAYS, type Entry, type Event, LEDGER, MAY_ASK, MOVES, type Move, RENAME, SET_ACTIVE, TABS, TAKEN, TILLS,
  type Taken, type Till, type TillDay, askSays, cleanName, expectedCash, stateLine, tabOf, takesRequests, tillState,
} from "@/lib/pos";
import { Submit, Wait } from "../../busy";
import { Flash, type Search, one } from "../../ui";
import { askCashOut, askClose, cancelAsk } from "../actions";
import { CloseDayKey } from "../ask";
import { CashFlow } from "./cash";
import { General } from "./general";
import { Settings } from "./settings";
import { Trace } from "./trace";

const MOST_EVENTS = 1000;
const MOST_MOVES = 500;

// The Settings tab's two changes, for a login that may change how a till is
// set up. A till belongs to the business whose connection this is: one of
// another business matches nothing.
const back = (id: string) => (UUID.test(id) ? `/backoffice/pos/${id}?tab=settings` : "/backoffice/pos");

async function rename(f: FormData) {
  "use server";
  const id = String(f.get("till") ?? "");
  await act("settings.device", back(id), async (c, ctx) => {
    const name = cleanName(f.get("name"));
    if (!UUID.test(id) || !name) throw new Refused("Give the till a name of up to 40 characters.");
    const done = await c.query(RENAME, [ctx.tenantId, id, name]);
    if (done.rowCount !== 1) throw new Refused("That till is not one of yours.");
    return `Renamed to ${name}. The tablet shows it after its next sync.`;
  });
}

async function setActive(f: FormData) {
  "use server";
  const id = String(f.get("till") ?? "");
  const active = f.get("active") === "yes";
  await act("settings.device", back(id), async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That till is not one of yours.");
    const done = await c.query(SET_ACTIVE, [ctx.tenantId, id, active]);
    if (done.rowCount !== 1) throw new Refused("That till is not one of yours.");
    return active
      ? "Reactivated. The tablet is given its key again at its next sync."
      : "Deactivated. A tablet still signed in carries on under its login until it is signed out.";
  });
}

// One till: what it took today, its settings, its cash flow and everything it
// did, in four tabs after Carfection's device page. Each tab reads only what
// it shows.
export default async function TillPage({ params, searchParams }: { params: Promise<{ till: string }>; searchParams: Search }) {
  const { till: id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const tab = tabOf(one(sp.tab));
  const ctx = await tenantContext();

  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    const day = today(b.tz);
    const tills = (await c.query(TILLS, [ctx.tenantId, day])).rows as Till[];
    const t = tills.find((x) => x.id === id);
    if (!t) return null;
    const newest = Math.max(0, ...tills.filter((x) => !x.off).map((x) => x.till_version ?? 0));
    // a day the address asks for that no calendar has is today
    const asked = (key: "ref" | "from" | "to") => (isDay(one(sp[key])) ? one(sp[key]) : day);
    const [from, to] = [asked("from"), asked("to")].sort();
    // what this person may ask of a till, and what was asked of this one and still waits
    const [may, waiting] = await Promise.all([c.query(MAY_ASK, [ctx.employeeId]), c.query(ASKED, [ctx.tenantId, id, true, 20])]);
    const base = {
      tz: b.tz, ok: b.ok, s: withDefaults(b.settings), t, day, newest, ref: asked("ref"), from, to,
      may: { close: Boolean(may.rows[0]?.close), cash: Boolean(may.rows[0]?.cash) }, waiting: waiting.rows as Asked[],
    };

    if (tab === "general") {
      const [taken, days, last] = await Promise.all([
        b.ok ? c.query(TAKEN, [ctx.tenantId, id, day, b.tz]) : { rows: [] },
        c.query(DAYS, [ctx.tenantId, id, 6]),
        c.query(ACTIVITY, [ctx.tenantId, day, day, id, 1, b.tz]),
      ]);
      return { ...base, tab, taken: taken.rows as Taken[], days: days.rows as TillDay[], last: (last.rows[0] as Event | undefined) ?? null };
    }
    if (tab === "settings") {
      const can = Boolean((await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId])).rows[0]?.ok);
      return { ...base, tab, can };
    }
    if (!b.ok) return { ...base, tab: "none" as const };
    if (tab === "cash") {
      const closures = (await c.query(CLOSURES, [ctx.tenantId, id, base.ref, b.tz])).rows as Closure[];
      // the day open now is part of today's history, ahead of what was closed
      const openNow = t.shift_id !== null && base.ref === day ? t.shift_id : null;
      const [lines, moves, asks] = await Promise.all([
        Promise.all([...(openNow ? [openNow] : []), ...closures.map((x) => x.id)].map((shift) => c.query(LEDGER, [ctx.tenantId, shift]).then((r) => [shift, r.rows as Entry[]] as const))),
        c.query(MOVES, [ctx.tenantId, id, from, to, b.tz, MOST_MOVES]),
        c.query(ASKED, [ctx.tenantId, id, false, 10]),
      ]);
      return { ...base, tab, closures, openNow, lines: new Map(lines), moves: moves.rows as (Move & { total: number })[], asks: asks.rows as Asked[] };
    }
    const events = (await c.query(ACTIVITY, [ctx.tenantId, from, to, id, MOST_EVENTS, b.tz])).rows as Event[];
    return { ...base, tab, events };
  });
  if (!d) notFound();

  const { t } = d;
  const now = new Date();
  const seen = t.seen ? new Date(t.seen) : null;
  const state = tillState(seen, now, t.off);
  const build = t.till_version === null ? t.app_version : `Build ${t.till_version}`;
  const here = `/backoffice/pos/${t.id}`;
  // where a request made on this tab comes back to
  const back = tab === "general" ? here : `${here}?tab=${tab}`;
  const at = clock(d.tz);
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const closing = d.waiting.some((q) => q.kind === "close_day");

  return (
    <div>
      <p className="crumb">
        <Link href="/backoffice/pos">Point of sale</Link> ›
      </p>
      <div className="till-head">
        <span className="till-ico" aria-hidden="true">
          <TabletSmartphone strokeWidth={1.9} />
        </span>
        <div>
          <h1>
            {t.name}
            {t.off && <span className="badge">Deactivated</span>}
          </h1>
          <p className="till-facts">
            {!t.off && (
              <span className="till-sync">
                <i className={"dot" + (state === "ok" ? " on" : "")} aria-hidden="true" />
                {stateLine(state, seen, now)}
              </span>
            )}
            <span>{t.store}</span>
            <span>{t.code}</span>
            {build && <span>{build}</span>}
            {!t.off && t.till_version !== null && t.till_version < d.newest && <span className="badge amber">Older than build {d.newest}</span>}
          </p>
        </div>
        {/* its day closed from here: the till closes it itself, the next time it syncs */}
        {t.shift_id && d.may.close && !closing && !t.off && (
          <div className="till-acts">
            {takesRequests(t) ? (
              <CloseDayKey
                action={askClose}
                till={t.id}
                name={t.name}
                expected={d.ok ? m(expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out)) : null}
                back={back}
              />
            ) : (
              <span className="muted">Update this till to close its day from here.</span>
            )}
          </div>
        )}
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <Link key={key} href={key === "general" ? here : `${here}?tab=${key}`} className={tab === key ? "on" : undefined}>
            {label}
            <Wait />
          </Link>
        ))}
      </div>
      <Flash sp={sp} />
      {d.waiting.map((q) => (
        <form key={q.id} action={cancelAsk} className="note asked">
          <input type="hidden" name="till" value={t.id} />
          <input type="hidden" name="id" value={q.id} />
          <input type="hidden" name="kind" value={q.kind} />
          <input type="hidden" name="back" value={back} />
          <span>
            <strong>{d.ok || q.kind === "close_day" ? askSays(q, m) : "Take cash out"}</strong>
            Asked {at(q.requested_at)}
            {q.who ? ` by ${q.who}` : ""}. The till carries it out, as of then, the next time it syncs: at once while someone is using it, otherwise when it is next touched. It says here if it could not.
          </span>
          {(q.kind === "close_day" ? d.may.close : d.may.cash) && <Submit className="btn-quiet btn-sm">Cancel it</Submit>}
        </form>
      ))}

      {d.tab === "general" && <General d={d} mode={ctx.mode} now={now} />}
      {d.tab === "settings" && <Settings d={d} rename={rename} setActive={setActive} />}
      {d.tab === "none" && <div className="note warn">Your role does not include seeing reports.</div>}
      {d.tab === "cash" && <CashFlow d={d} here={here} askCashOut={askCashOut} />}
      {d.tab === "trace" && <Trace d={d} here={here} most={MOST_EVENTS} />}
    </div>
  );
}
