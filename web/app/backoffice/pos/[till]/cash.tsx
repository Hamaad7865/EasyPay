import { Banknote } from "lucide-react";
import { money } from "@/lib/settings";
import { clock, fmtDay } from "@/lib/report";
import { type Asked, type Closure, type Entry, type Move, askEnded, askSays, expectedCash, splitMoves, takesRequests, variance } from "@/lib/pos";
import { Go, Submit } from "../../busy";
import { Card, Empty } from "../../ui";
import { Stat } from "../../reports/parts";
import { CashOutKey } from "../ask";
import type { Base } from "./types";

// What a line of the drawer is called, and the colour of its tag.
const LINE: Record<string, [string, string]> = {
  sale: ["Cash sale", "green"],
  refund: ["Cash refund", "red"],
  cash_in: ["Cash in", "green"],
  cash_out: ["Cash out", "amber"],
  cash_drawer: ["Drawer opened", "amber"],
  count: ["Drawer counted", "blue"],
};

// Cash flow, after Carfection's: how the drawer was left each time the day
// was closed on a chosen date, then every payment in and out of the till
// over a from-to range. Under each closure is what EasyPay had before: the
// drawer line by line, with what it held after each line.
export function CashFlow({
  d,
  here,
  askCashOut,
}: {
  d: Base & { closures: Closure[]; openNow: string | null; lines: Map<string, Entry[]>; moves: (Move & { total: number })[]; asks: Asked[] };
  here: string;
  askCashOut: (f: FormData) => Promise<void>;
}) {
  const { t } = d;
  const at = clock(d.tz);
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "") + m(Math.abs(n));
  const tag = (counted: unknown, expected: unknown) => {
    const v = variance(counted, expected);
    return v && <span className={"badge " + v.tone}>{v.off === 0 ? v.word : `${v.word} ${m(Math.abs(v.off))}`}</span>;
  };
  const { inflows, outflows, inTotal, outTotal } = splitMoves(d.moves);
  const cut = (list: { total: number }[]) => (list.length > 0 && list[0].total > list.length ? list[0].total : null);

  // the drawer line by line, from its float to its closing count
  const ledger = (shift: string, float: string | null, openedAt: string | null, openedBy: string | null, closed: Closure | null) => {
    let running = Number(float ?? 0);
    const lines = (d.lines.get(shift) ?? []).map((e) => {
      running += Number(e.amount);
      return { ...e, after: running };
    });
    return (
      <details className="card flush">
        <summary className="card-head" style={{ cursor: "pointer" }}>
          <div>
            <h2>The drawer line by line</h2>
            <p>The float, each cash sale and refund, cash put in and paid out, and each count, with what the drawer held after each.</p>
          </div>
          <span className="btn-quiet btn-sm">Open</span>
        </summary>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Detail</th>
              <th>By</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th className="num">In the drawer</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ whiteSpace: "nowrap" }}>{at(openedAt)}</td>
              <td><span className="badge blue">Day opened</span></td>
              <td>Opening float, as counted</td>
              <td style={{ whiteSpace: "nowrap" }}>{openedBy ?? ""}</td>
              <td className="num">{m(float)}</td>
              <td className="num" />
              <td className="num strong">{m(float)}</td>
            </tr>
            {lines.map((e, i) => {
              const [label, tone] = LINE[e.kind] ?? [e.kind, ""];
              const amount = Number(e.amount);
              return (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{at(e.at)}</td>
                  <td><span className={"badge " + tone}>{label}</span></td>
                  <td>
                    {e.kind === "count" ? (
                      <>Counted {m(e.counted)}, expected {m(e.expected)} {tag(e.counted, e.expected)}</>
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
            {closed && (
              <tr>
                <td style={{ whiteSpace: "nowrap" }}>{at(closed.closed_at)}</td>
                <td><span className="badge blue">Day closed</span></td>
                <td>
                  {closed.close_no !== null ? `Day closing no. ${closed.close_no}. ` : ""}
                  {closed.counted_cash === null ? "Not counted" : <>Counted {m(closed.counted_cash)}, expected {m(closed.expected_cash)} {tag(closed.counted_cash, closed.expected_cash)}</>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{closed.closed_by ?? ""}</td>
                <td className="num" />
                <td className="num" />
                <td className="num strong">{closed.counted_cash === null ? "" : m(closed.counted_cash)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </details>
    );
  };

  return (
    <div>
      <h2>History</h2>
      <p className="lede">How the drawer was left each time the day was closed on a date, and the drawer line by line.</p>
      <Go className="filters" action={here}>
        <input type="hidden" name="tab" value="cash" />
        <input type="hidden" name="from" value={d.from} />
        <input type="hidden" name="to" value={d.to} />
        <label>
          Closed on
          <input type="date" name="ref" defaultValue={d.ref} />
        </label>
        <Submit>Show</Submit>
      </Go>

      {d.openNow && (
        <>
          <div className="stats">
            <Stat label="Open now · opening float" value={m(t.opening_float)} note={`${at(t.opened_at)}${t.opened_by ? ` by ${t.opened_by}` : ""}`} />
            <Stat label="Cash taken" value={m(t.cash_taken)} note="cash sales, less cash refunds" />
            <Stat label="Cash in and out" value={signed(Number(t.cash_in ?? 0) - Number(t.cash_out ?? 0))} note={`${m(t.cash_in)} in, ${m(t.cash_out)} out`} />
            <Stat label="Expected in drawer now" value={m(expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out))} note="as of the till's last sync" />
          </div>
          {ledger(d.openNow, t.opening_float, t.opened_at, t.opened_by, null)}
        </>
      )}

      {d.closures.length === 0 && !d.openNow ? (
        <Empty icon={Banknote} title={`No day was closed on ${fmtDay(d.ref)}`}>A day is closed on the till, by counting the cash in its drawer. Pick another date.</Empty>
      ) : (
        d.closures.map((x) => {
          const came = expectedCash(x.opening_float, x.cash_taken, x.cash_in, x.cash_out);
          // a closed day is held to what the till expected when it closed it
          const expected = x.expected_cash !== null ? Number(x.expected_cash) : came;
          const v = variance(x.counted_cash, expected);
          return (
            <div key={x.id}>
              <h3 className="closure">
                Closed {at(x.closed_at)}
                {x.closed_by ? ` by ${x.closed_by}` : ""}
                {x.close_no !== null ? ` · Day closing no. ${x.close_no}` : ""}
              </h3>
              <div className="stats">
                <Stat label="Opening float" value={m(x.opening_float)} note={`${at(x.opened_at)}${x.opened_by ? ` by ${x.opened_by}` : ""}`} />
                <Stat label="Cash taken" value={m(x.cash_taken)} note="cash sales, less cash refunds" />
                <Stat label="Cash in and out" value={signed(Number(x.cash_in) - Number(x.cash_out))} note={`${m(x.cash_in)} in, ${m(x.cash_out)} out`} />
                <Stat
                  label="Counted at closing"
                  value={x.counted_cash === null ? "Not counted" : m(x.counted_cash)}
                  note={v === null ? undefined : `expected ${m(expected)}, ${v.off === 0 ? "balanced" : (v.off < 0 ? "short by " : "over by ") + m(Math.abs(v.off))}`}
                />
              </div>
              {x.asked && (
                <div className="note">
                  <strong>Closed from the back office{x.asked.who ? `, asked by ${x.asked.who}` : ""}</strong>
                  {x.asked.counted
                    ? "The till closed its own day when it next synced, with the count typed here."
                    : "The till closed its own day when it next synced, at what it expected: nobody counted the drawer."}
                </div>
              )}
              {x.non_cash.length > 0 && (
                <div className="note">
                  <strong>Not in the drawer</strong>
                  {x.non_cash.map((n) => `${n.name} ${m(n.amount)}`).join(" · ")}. Paid another way than cash, so it never touched the drawer.
                </div>
              )}
              {expected !== came && (
                <div className="note">
                  <strong>The till closed this day expecting {m(expected)}; its lines now come to {m(came)}</strong>
                  The difference is something that changed after the day was closed: a sale that reached the server later, or a payment whose type was corrected since.
                </div>
              )}
              {ledger(x.id, x.opening_float, x.opened_at, x.opened_by, x)}
            </div>
          );
        })
      )}

      <h2 style={{ marginTop: 28 }}>Cash movements</h2>
      <p className="lede">Every payment in and out of this till over a period, whatever it was paid with, and the cash put in and paid out.</p>
      <Go className="filters" action={here}>
        <input type="hidden" name="tab" value="cash" />
        <input type="hidden" name="ref" value={d.ref} />
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
      {/* cash taken out, written down from here: the till records it the next time it syncs */}
      {t.shift_id && d.may.cash && !t.off && (
        <p className="till-acts left">
          {takesRequests(t) ? (
            <CashOutKey action={askCashOut} till={t.id} name={t.name} back={`${here}?tab=cash`} />
          ) : (
            <span className="muted">Update this till to record cash taken out from here.</span>
          )}
        </p>
      )}

      <Card title="Inflows" action={<span className="badge green">{m(inTotal)}</span>} flush>
        {inflows.length === 0 ? (
          <div className="card-body"><p className="muted" style={{ margin: 0 }}>Nothing came in over this period.</p></div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>By</th>
                <th>Method</th>
                <th>Receipt</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inflows.map((x, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{at(x.at)}</td>
                  <td>{x.who ?? ""}</td>
                  <td>{x.method}</td>
                  <td>{x.ref ?? <span className="muted">{x.type}{x.comment ? ` · ${x.comment}` : ""}</span>}</td>
                  <td className="num strong">{m(x.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {cut(inflows) !== null && <div className="note">Showing the latest {inflows.length.toLocaleString("en-US")} of {cut(inflows)!.toLocaleString("en-US")} inflows, and the total above is for those. Pick a shorter period to see them all.</div>}

      <Card title="Outflows" action={<span className="badge red">{m(outTotal)}</span>} flush>
        {outflows.length === 0 ? (
          <div className="card-body"><p className="muted" style={{ margin: 0 }}>Nothing went out over this period.</p></div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>By</th>
                <th>Method</th>
                <th className="num">Amount</th>
                <th>Type</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {outflows.map((x, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{at(x.at)}</td>
                  <td>{x.who ?? ""}</td>
                  <td>{x.method}</td>
                  <td className="num strong">-{m(x.amount)}</td>
                  <td>{x.type}{x.ref ? ` ${x.ref}` : ""}</td>
                  <td>{x.comment ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {cut(outflows) !== null && <div className="note">Showing the latest {outflows.length.toLocaleString("en-US")} of {cut(outflows)!.toLocaleString("en-US")} outflows, and the total above is for those. Pick a shorter period to see them all.</div>}
      {d.asks.length > 0 && (
        <Card title="Asked from the back office" lede="What this till was asked to do from here, and how each ended. The till carries a request out the next time it syncs." flush>
          <table>
            <thead>
              <tr>
                <th>Asked</th>
                <th>By</th>
                <th>What</th>
                <th>How it ended</th>
              </tr>
            </thead>
            <tbody>
              {d.asks.map((q) => {
                const [ended, tone] = askEnded(q);
                return (
                  <tr key={q.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{at(q.requested_at)}</td>
                    <td>{q.who ?? ""}</td>
                    <td>{askSays(q, m)}</td>
                    <td>
                      <span className={"badge " + tone} style={{ whiteSpace: "normal" }}>{ended}</span>
                      {q.answered_at && q.status !== "waiting" && <span className="sub">{at(q.answered_at)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <p className="muted" style={{ fontSize: 12.5 }}>Figures are as of the till&apos;s last sync. A payment whose type was corrected shows as what it was corrected to.</p>
    </div>
  );
}
