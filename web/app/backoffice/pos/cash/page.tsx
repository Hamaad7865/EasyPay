import Link from "next/link";
import { Banknote } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { money, withDefaults } from "@/lib/settings";
import { basics, clock, today } from "@/lib/report";
import { type Entry, LEDGER, SHIFT, SHIFTS, TILLS, type Till, ago, expectedCash } from "@/lib/pos";
import { Empty, PageHead, type Search, one } from "../../ui";
import { Stat } from "../../reports/parts";

type Day = { id: string; opened_at: string; closed_at: string | null };
type Drawer = {
  id: string; device_id: string; opened_at: string; closed_at: string | null; opening_float: string; expected_cash: string | null; counted_cash: string | null;
  opened_by: string | null; closed_by: string | null; till: string; code: string; cash_taken: string; cash_in: string; cash_out: string; close_no: number | null;
};

const KIND: Record<string, [string, string]> = {
  sale: ["Cash sale", "green"],
  refund: ["Cash refund", "red"],
  cash_in: ["Cash in", "green"],
  cash_out: ["Cash out", "amber"],
  cash_drawer: ["Drawer opened", "amber"],
  count: ["Drawer counted", "blue"],
};

// The cash in a till's drawer over one of its days, and everything that
// moved it, in the order it happened: the opening float, each cash sale and
// refund, cash put in and taken out, each count, and the count that closed
// the day. Day closing has the day's totals; this is the drawer line by line.
export default async function CashFlow({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    if (!b.ok) return { ok: false as const };
    const tills = (await c.query(TILLS, [ctx.tenantId, today(b.tz)])).rows as Till[];
    // the till asked for, or the first with its day open, or the first there is
    const asked = UUID.test(one(sp.till)) ? tills.find((t) => t.id === one(sp.till)) : undefined;
    const till = asked ?? tills.find((t) => t.shift_id !== null) ?? tills[0];
    const days = till ? ((await c.query(SHIFTS, [ctx.tenantId, till.id])).rows as Day[]) : [];
    // the day asked for when it is one of this till's, or its latest
    const day = days.find((x) => x.id === one(sp.day)) ?? days[0];
    const [drawer, ledger] = day
      ? await Promise.all([c.query(SHIFT, [ctx.tenantId, day.id]), c.query(LEDGER, [ctx.tenantId, day.id])])
      : [{ rows: [] }, { rows: [] }];
    return { ok: true as const, tz: b.tz, s: withDefaults(b.settings), tills, till, days, day, drawer: drawer.rows[0] as Drawer | undefined, entries: ledger.rows as Entry[] };
  });
  const head = (
    <PageHead
      title="Cash flow"
      lede="The cash in each drawer and everything that moved it: the opening float, each cash sale and refund, cash put in and taken out, and each count. Figures are as of each till's last sync."
    />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;

  const now = new Date();
  const at = clock(d.tz);
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "") + m(Math.abs(n));
  const balance = (off: number) =>
    off === 0 ? <span className="badge green">Balanced</span> : <span className={"badge " + (off < 0 ? "red" : "amber")}>{off < 0 ? "Short " : "Over "}{m(Math.abs(off))}</span>;
  const open = d.tills.filter((t) => !t.off && t.shift_id !== null);
  const dayName = (x: Day) => (x.closed_at ? `${at(x.opened_at)} to ${at(x.closed_at)}` : `Open now, since ${at(x.opened_at)}`);

  // the drawer line by line, with what it held after each
  const sh = d.drawer;
  let running = Number(sh?.opening_float ?? 0);
  const lines = d.entries.map((e) => {
    running += Number(e.amount);
    return { ...e, after: running };
  });
  const came = sh ? expectedCash(sh.opening_float, sh.cash_taken, sh.cash_in, sh.cash_out) : 0;
  // a closed day is held to what the till expected when it closed it
  const closedAt = sh?.closed_at ?? null;
  const expected = sh && closedAt && sh.expected_cash !== null ? Number(sh.expected_cash) : came;
  const counted = sh && sh.counted_cash !== null ? Number(sh.counted_cash) : null;

  return (
    <div>
      {head}
      {d.tills.length === 0 ? (
        <Empty icon={Banknote} title="No till is set up yet">Cash flow shows once a till has opened a day.</Empty>
      ) : (
        <>
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>Drawers open now</h2>
                <p>What each drawer should hold at this moment, from what its till has sent.</p>
              </div>
            </div>
            {open.length === 0 ? (
              <div className="card-body"><p className="muted" style={{ margin: 0 }}>No till has its day open.</p></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Till</th><th>Opened</th><th className="num">Float</th><th className="num">Cash taken</th><th className="num">Cash in</th>
                    <th className="num">Cash out</th><th className="num">Expected in drawer</th><th>Last synced</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((t) => (
                    <tr key={t.id}>
                      <td className="strong"><Link href={`/backoffice/pos/cash?till=${t.id}`}>{t.name}</Link></td>
                      <td>{at(t.opened_at)}{t.opened_by ? ` by ${t.opened_by}` : ""}</td>
                      <td className="num">{m(t.opening_float)}</td>
                      <td className="num">{m(t.cash_taken)}</td>
                      <td className="num">{m(t.cash_in)}</td>
                      <td className="num">-{m(t.cash_out)}</td>
                      <td className="num strong">{m(expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out))}</td>
                      <td>{t.seen ? ago(new Date(t.seen), now) : "Not yet"}</td>
                    </tr>
                  ))}
                  {open.length > 1 && (
                    <tr>
                      <td className="strong" colSpan={6}>All drawers</td>
                      <td className="num strong">{m(open.reduce((a, t) => a + expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out), 0))}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </section>

          <form className="filters" action="/backoffice/pos/cash">
            <label>
              Till
              <select name="till" defaultValue={d.till?.id ?? ""}>
                {d.tills.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code}){t.off ? ", deactivated" : ""}</option>)}
              </select>
            </label>
            {d.days.length > 0 && (
              <label>
                Day
                <select name="day" defaultValue={d.day?.id ?? ""}>
                  {d.days.map((x) => <option key={x.id} value={x.id}>{dayName(x)}</option>)}
                </select>
              </label>
            )}
            <button type="submit">Show</button>
          </form>

          {!sh ? (
            <Empty icon={Banknote} title={`${d.till?.name ?? "This till"} has not opened a day yet`}>A day is opened on the till, by counting the cash in its drawer.</Empty>
          ) : (
            <>
              <div className="stats">
                <Stat label="Opening float" value={m(sh.opening_float)} note={`${at(sh.opened_at)}${sh.opened_by ? ` by ${sh.opened_by}` : ""}`} />
                <Stat label="Cash taken" value={m(sh.cash_taken)} note="cash sales, less cash refunds" />
                <Stat label="Cash in and out" value={signed(Number(sh.cash_in) - Number(sh.cash_out))} note={`${m(sh.cash_in)} in, ${m(sh.cash_out)} out`} />
                {closedAt ? (
                  <Stat
                    label="Counted at closing"
                    value={counted === null ? "Not counted" : m(counted)}
                    note={counted === null ? undefined : `expected ${m(expected)}, ${counted === expected ? "balanced" : (counted < expected ? "short by " : "over by ") + m(Math.abs(counted - expected))}`}
                  />
                ) : (
                  <Stat label="Expected in drawer now" value={m(expected)} note="as of the till's last sync" />
                )}
              </div>
              {closedAt && expected !== came && (
                <div className="note">
                  <strong>The till closed this day expecting {m(expected)}; the lines below come to {m(came)}</strong>
                  The difference is something that changed after the day was closed: a sale that reached the server later, or a payment whose type was corrected since.
                </div>
              )}
              <table>
                <thead>
                  <tr><th>When</th><th>What</th><th>Detail</th><th>By</th><th className="num">In</th><th className="num">Out</th><th className="num">In the drawer</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ whiteSpace: "nowrap" }}>{at(sh.opened_at)}</td>
                    <td><span className="badge blue">Day opened</span></td>
                    <td>Opening float, as counted</td>
                    <td style={{ whiteSpace: "nowrap" }}>{sh.opened_by ?? ""}</td>
                    <td className="num">{m(sh.opening_float)}</td><td className="num" />
                    <td className="num strong">{m(sh.opening_float)}</td>
                  </tr>
                  {lines.map((e, i) => {
                    const [label, tone] = KIND[e.kind] ?? [e.kind, ""];
                    const amount = Number(e.amount);
                    const off = e.counted !== null && e.expected !== null ? Number(e.counted) - Number(e.expected) : null;
                    return (
                      <tr key={i}>
                        <td style={{ whiteSpace: "nowrap" }}>{at(e.at)}</td>
                        <td><span className={"badge " + tone}>{label}</span></td>
                        <td>
                          {e.kind === "count" ? (
                            <>Counted {m(e.counted)}, expected {m(e.expected)} {off !== null && balance(off)}</>
                          ) : e.kind === "cash_drawer" ? (
                            "With no sale"
                          ) : e.kind === "sale" || e.kind === "refund" ? (
                            <>{e.ref}{e.words && e.words !== "Cash" ? ` · ${e.words}` : ""}</>
                          ) : (
                            e.words ?? ""
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>{e.who ?? ""}</td>
                        <td className="num">{amount > 0 ? m(amount) : ""}</td>
                        <td className="num">{amount < 0 ? m(-amount) : ""}</td>
                        <td className="num strong">{m(e.after)}</td>
                      </tr>
                    );
                  })}
                  {closedAt && (
                    <tr>
                      <td style={{ whiteSpace: "nowrap" }}>{at(closedAt)}</td>
                      <td><span className="badge blue">Day closed</span></td>
                      <td>
                        {sh.close_no !== null ? `Day closing no. ${sh.close_no}. ` : ""}
                        {counted === null ? "Not counted" : <>Counted {m(counted)}, expected {m(expected)} {balance(counted - expected)}</>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{sh.closed_by ?? ""}</td>
                      <td className="num" /><td className="num" />
                      <td className="num strong">{counted === null ? "" : m(counted)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 12.5 }}>
                Only cash is here: a sale paid by card or another way does not touch the drawer. The day&apos;s totals by payment method are under Day closing.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
