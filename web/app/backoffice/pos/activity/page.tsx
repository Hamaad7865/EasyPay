import { Activity as ActivityIcon } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { isDay } from "@/lib/day";
import { money, withDefaults } from "@/lib/settings";
import { basics, fmtDay, today } from "@/lib/report";
import { ACTIVITY, type Event, LATE_SECONDS, isLate, span } from "@/lib/pos";
import { Empty, PageHead, type Search, one } from "../../ui";
import { Stat } from "../../reports/parts";

const MOST = 1000;

// What each kind of event is called, and the colour of its tag.
const KIND: Record<string, [string, string]> = {
  sale: ["Sale", "green"],
  refund: ["Refund", "red"],
  cash_in: ["Cash in", "green"],
  cash_out: ["Cash out", "amber"],
  cash_drawer: ["Drawer opened", "amber"],
  count: ["Drawer counted", "blue"],
  open: ["Day opened", "blue"],
  close: ["Day closed", "blue"],
  clock_in: ["Clocked in", ""],
  clock_out: ["Clocked out", ""],
  crash: ["Stopped unexpectedly", "red"],
};

// What a till did on one day, in the order it happened, newest first. Each
// line also says when it reached the server long after the till wrote it
// down: that is a till that was selling with no network.
export default async function TillActivity({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    const day = isDay(one(sp.day)) ? one(sp.day) : today(b.tz);
    const till = UUID.test(one(sp.till)) ? one(sp.till) : null;
    if (!b.ok) return { ok: false as const };
    const [tills, events] = await Promise.all([
      c.query(`select id, name, code, deleted_at is not null as off from pos_devices where tenant_id = $1 order by deleted_at is not null, code, name`, [ctx.tenantId]),
      c.query(ACTIVITY, [ctx.tenantId, day, till, MOST, b.tz]),
    ]);
    return {
      ok: true as const, tz: b.tz, s: withDefaults(b.settings), day, till,
      tills: tills.rows as { id: string; name: string; code: string; off: boolean }[], rows: events.rows as Event[],
    };
  });
  const head = (
    <PageHead
      title="Till activity"
      lede="What each till did on a day, newest first: its day opened and closed, every sale and refund, cash put in and taken out, the drawer opened and counted, people clocking in and out, and the app stopping unexpectedly."
    />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;

  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: d.tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const total = d.rows[0]?.total ?? 0;
  const sales = d.rows.filter((e) => e.kind === "sale");
  const late = d.rows.filter((e) => isLate(e.late));
  const crashes = d.rows.filter((e) => e.kind === "crash").length;
  const many = d.till === null && d.tills.length > 1;
  // the column is only there on a day when something did not arrive as it happened
  const off = (e: Event) => isLate(e.late) || (e.late !== null && e.late < -LATE_SECONDS);
  const anyOff = d.rows.some(off);
  const diff = (counted: string | null, expected: string | null) => {
    if (counted === null || expected === null) return "";
    const off = Number(counted) - Number(expected);
    return off === 0 ? ", balanced" : `, ${off < 0 ? "short" : "over"} by ${m(Math.abs(off))}`;
  };
  // what a line says about itself
  const detail = (e: Event) => {
    switch (e.kind) {
      case "sale": case "refund": return e.ref ?? "";
      case "cash_in": case "cash_out": return e.words ?? "";
      case "cash_drawer": return "With no sale";
      case "count": return `Counted ${m(e.amount)}, expected ${m(e.extra)}${diff(e.amount, e.extra)}`;
      case "open": return `Opening float ${m(e.amount)}`;
      case "close": return `Day closing no. ${e.ref}` + (e.amount !== null && e.extra !== null ? `. Counted ${m(e.amount)}, expected ${m(e.extra)}${diff(e.amount, e.extra)}` : "");
      case "crash": return (e.words ?? "") + (e.ref ? ` (version ${e.ref})` : "");
      default: return "";
    }
  };
  const amount = (e: Event) => {
    if (e.amount === null) return "";
    switch (e.kind) {
      case "sale": case "cash_in": return m(e.amount);
      case "refund": case "cash_out": return "-" + m(e.amount);
      default: return "";
    }
  };

  return (
    <div>
      {head}
      <form className="filters" action="/backoffice/pos/activity">
        <label>
          Till
          <select name="till" defaultValue={d.till ?? ""}>
            <option value="">All tills</option>
            {d.tills.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code}){t.off ? ", deactivated" : ""}</option>)}
          </select>
        </label>
        <label>
          Day
          <input type="date" name="day" defaultValue={d.day} />
        </label>
        <button type="submit">Show</button>
      </form>

      {d.rows.length === 0 ? (
        <Empty icon={ActivityIcon} title={`Nothing on ${fmtDay(d.day)}`}>No till sent anything for that day. Pick another day, or another till.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Events" value={total.toLocaleString("en-US")} note={fmtDay(d.day)} />
            <Stat label="Sales" value={m(sales.reduce((a, e) => a + Number(e.amount ?? 0), 0))} note={`${sales.length} ${sales.length === 1 ? "receipt" : "receipts"}`} />
            <Stat
              label="Reached the server late"
              value={String(late.length)}
              note={late.length === 0 ? "Everything arrived as it happened" : `the slowest after ${span(Math.max(...late.map((e) => e.late ?? 0)))}`}
            />
            <Stat label="Stopped unexpectedly" value={String(crashes)} note={crashes === 0 ? "The app did not stop" : "The report is with EasyPay"} />
          </div>
          {total > d.rows.length && (
            <div className="note">Showing the latest {d.rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} events, and the figures above are for those. Pick one till to see fewer.</div>
          )}
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {many && <th>Till</th>}
                <th>What</th>
                <th>Detail</th>
                <th>By</th>
                <th className="num">Amount</th>
                {anyOff && <th>Reached the server</th>}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((e, i) => {
                const [label, tone] = KIND[e.kind] ?? [e.kind, ""];
                return (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{time.format(new Date(e.at))}</td>
                    {many && <td style={{ whiteSpace: "nowrap" }}>{e.till ?? ""} <span className="muted">{e.code ?? ""}</span></td>}
                    <td><span className={"badge " + tone}>{label}</span></td>
                    <td>{detail(e)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{e.who ?? ""}</td>
                    <td className="num strong">{amount(e)}</td>
                    {anyOff && (
                      <td>
                        {isLate(e.late) ? (
                          <span className="badge amber">{span(e.late!)} later</span>
                        ) : e.late !== null && e.late < -LATE_SECONDS ? (
                          <span className="badge">The till&apos;s clock is {span(-e.late)} ahead</span>
                        ) : null}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Times are the till&apos;s own. A till sends each thing as it happens; one that arrived more than two minutes later was made while the till had no network, and was sent when it came back.
          </p>
        </>
      )}
    </div>
  );
}
