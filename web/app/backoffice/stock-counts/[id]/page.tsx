import Link from "next/link";
import { notFound } from "next/navigation";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, UUID, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { COUNT_STATUS, COUNT_TONE, countProblem, type CountStatus, LINE_STATE, type LineState, reviewTotals } from "@/lib/counts";
import { units } from "@/lib/stock";
import { Card, Flash, one, PageHead, type Search } from "../../ui";
import { Submit, Wait } from "../../busy";
import { PrintButton } from "../../reports/print-button";
import { countScan, countSet } from "./actions";
import { type CountLine, Counting, type Recent } from "./counting";

const PATH = "/backoffice/stock-counts";

// What the count functions refuse (migration 0075) comes back as its sentence.
async function ruled<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const why = e instanceof Error ? countProblem(e.message) : null;
    if (why) throw new Refused(why);
    throw e;
  }
}

// A line counted again from nothing, left out of the count, or put back.
async function lineAction(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  const show = String(f.get("show") ?? "");
  await act("stock.count", `${PATH}/${id}${/^[a-z]+$/.test(show) ? "?show=" + show : ""}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That count is no longer there.");
    const what = String(f.get("what") ?? "");
    await ruled(() => c.query(`select count_line($1, $2, $3, $4)`, [ctx.tenantId, id, uuid(f, "line"), what]));
    return what === "recount" ? "That line is to be counted again." : what === "leave" ? "Left out: completing the count will not touch that line." : "Back in the count.";
  });
}

async function completeCount(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("stock.count", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That count is no longer there.");
    const r = (await ruled(() => c.query(`select count_complete($1, $2, $3, $4) as r`, [ctx.tenantId, ctx.employeeId, id, String(f.get("uncounted") ?? "")]))).rows[0].r as { lines: number; units: number };
    if (r.lines === 0) return "Count completed. Every line counted matched: nothing had to be corrected.";
    return `Count completed: ${r.lines} ${r.lines === 1 ? "line" : "lines"} corrected, ${r.units > 0 ? "+" : ""}${units(r.units)} ${Math.abs(r.units) === 1000 ? "unit" : "units"} in all. Each correction is under Movements.`;
  });
}

async function cancelCount(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("stock.count", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That count is no longer there.");
    await ruled(() => c.query(`select count_cancel($1, $2)`, [ctx.tenantId, id]));
    return "Count cancelled. Stock was not changed.";
  });
}

type Head = { number: string; title: string; status: CountStatus; uncounted: string | null; started: string; by: string | null; completed: string | null; completed_by: string | null };
type Row = {
  line_id: string; item_id: string; variant_id: string | null; name: string; variant: string | null; sku: string | null; barcode: string | null;
  counted: number | null; counted_at: string | null; left_out: boolean; expected: number | null; diff: number | null; value: string | null; state: LineState;
};

const SHOW = ["different", "matching", "uncounted", "out"] as const;
function ago(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - new Date(at).getTime()) / 60000));
  return m < 1 ? "A moment ago" : m === 1 ? "1 minute ago" : m < 60 ? `${m} minutes ago` : m < 120 ? "1 hour ago" : `${Math.floor(m / 60)} hours ago`;
}

// One count: scanned and typed while it is open, with its review beside it;
// a report once it is completed.
export default async function CountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  if (!UUID.test(id)) notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, head, rows, settings] = await Promise.all([
      c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'stock.count') as count, has_perm($1, 'costs.view') as costs`, [ctx.employeeId]),
      c.query(
        `select c.number, c.title, c.status, c.uncounted,
                to_char(c.created_at at time zone s.timezone, 'FMDD FMMonth YYYY, HH24:MI') as started, e.name as by,
                to_char(c.completed_at at time zone s.timezone, 'FMDD FMMonth YYYY, HH24:MI') as completed, e2.name as completed_by
           from stock_counts c
           join stores s on s.tenant_id = c.tenant_id and s.id = c.store_id
           left join employees e on e.tenant_id = c.tenant_id and e.id = c.started_by
           left join employees e2 on e2.tenant_id = c.tenant_id and e2.id = c.completed_by
          where c.tenant_id = $1 and c.id = $2 and c.deleted_at is null`,
        [ctx.tenantId, id],
      ),
      c.query(`select * from count_review($1, $2)`, [ctx.tenantId, id]),
      loadSettings(c, ctx.tenantId),
    ]);
    return {
      may: may.rows[0] as { view: boolean; count: boolean; costs: boolean },
      head: (head.rows[0] as Head | undefined) ?? null,
      rows: (rows.rows as Row[]).sort((a, b) => a.name.localeCompare(b.name) || (a.variant ?? "").localeCompare(b.variant ?? "")),
      decimals: settings.decimals,
    };
  });
  if (!d.head || !d.may.view) notFound();
  const h = d.head;
  const open = h.status === "open";
  const rs = (cents: number) => money(Math.round(cents), d.decimals);
  const label = (r: Row) => r.name + (r.variant ? ", " + r.variant : "");
  const totals = reviewTotals(d.rows.map((r) => ({ state: r.state, diff: r.diff, value: r.value === null ? null : Number(r.value), left_out: r.left_out })));
  const asked = one(sp.show);
  // a cancelled count applied nothing: what its lines "should" hold would be today's stock, which says nothing about that day
  const figures = h.status !== "cancelled";
  const show = !figures ? "all" : (SHOW as readonly string[]).includes(asked) ? asked : open ? "different" : "all";
  const fits = d.rows.filter((r) => (show === "all" ? true : show === "out" ? r.left_out : !r.left_out && r.state === show));
  // a whole shop is thousands of lines: the page draws the first of them
  const MOST = 300;
  const shownRows = fits.slice(0, MOST);
  const now = Date.now();
  const lines: CountLine[] = d.rows.map((r) => ({ key: r.line_id, item: r.item_id, variant: r.variant_id, label: label(r), sku: r.sku, barcode: r.barcode }));
  const recent: Recent[] = d.rows
    .filter((r) => r.counted !== null && r.counted_at !== null)
    .sort((a, b) => new Date(b.counted_at!).getTime() - new Date(a.counted_at!).getTime())
    .slice(0, 8)
    .map((r) => ({ label: label(r), counted: r.counted!, when: ago(r.counted_at!, now) }));
  const signed = (q: number) => (q > 0 ? "+" : "") + units(q);
  const chip = (key: string, text: string) => (
    <Link key={key} href={`${PATH}/${id}?show=${key}`} className={show === key ? "on" : undefined}>
      {text}
      <Wait />
    </Link>
  );
  return (
    <div>
      <PageHead
        title={`Count ${h.number}: ${h.title}`}
        lede={
          open
            ? `Started ${h.started}${h.by ? " by " + h.by : ""}. ${totals.counted} of ${totals.lines} lines counted${totals.leftOut ? `, ${totals.leftOut} left out` : ""}.`
            : h.status === "completed"
              ? `Completed ${h.completed ?? ""}${h.completed_by ? " by " + h.completed_by : ""}. Lines that were not counted were ${h.uncounted === "zero" ? "set to zero" : "left as they were"}.`
              : `Cancelled. Stock was not changed. Started ${h.started}${h.by ? " by " + h.by : ""}.`
        }
      >
        <Link href={PATH} className="btn btn-quiet no-print">All counts</Link>
        {h.status === "completed" && <PrintButton />}
      </PageHead>
      <Flash sp={sp} />
      {h.status === "cancelled" && (
        <div className="stats">
          <div className="stat"><div className="stat-label">Count</div><div className="stat-value"><span className={COUNT_TONE[h.status]}>{COUNT_STATUS[h.status]}</span></div></div>
          <div className="stat"><div className="stat-label">Lines counted before it was cancelled</div><div className="stat-value">{totals.counted} of {totals.lines}</div></div>
        </div>
      )}
      {h.status === "completed" && (
        <div className="stats">
          <div className="stat"><div className="stat-label">Count</div><div className="stat-value"><span className={COUNT_TONE[h.status]}>{COUNT_STATUS[h.status]}</span></div></div>
          <div className="stat"><div className="stat-label">Lines counted</div><div className="stat-value">{totals.counted} of {totals.lines}</div></div>
          <div className="stat"><div className="stat-label">Lines that differed</div><div className="stat-value">{totals.different}</div></div>
          <div className="stat"><div className="stat-label">Net difference</div><div className="stat-value" style={totals.units < 0 ? { color: "var(--red)" } : undefined}>{signed(totals.units)}</div></div>
          {d.may.costs && <div className="stat"><div className="stat-label">At cost</div><div className="stat-value" style={totals.value < 0 ? { color: "var(--red)" } : undefined}>{rs(totals.value)}</div></div>}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        {open && d.may.count && (
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <Counting count={id} lines={lines} recent={recent} scan={countScan} set={countSet} />
          </div>
        )}
        <div style={{ flex: "2 1 520px", minWidth: 0 }}>
          <Card title={open ? "Review" : "What was counted"} flush>
            {figures && (
              <div className="tabs no-print" style={{ margin: "0 20px 0" }}>
                {!open && chip("all", `All, ${totals.lines}`)}
                {chip("different", `Different, ${totals.different}`)}
                {chip("matching", `Matching, ${totals.matching}`)}
                {chip("uncounted", `Not counted, ${totals.uncounted}`)}
                {totals.leftOut > 0 && chip("out", `Left out, ${totals.leftOut}`)}
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    {figures && <th className="num">Expected</th>}
                    <th className="num">Counted</th>
                    {figures && <th className="num">Difference</th>}
                    {figures && d.may.costs && <th className="num">In rupees</th>}
                    {open && d.may.count && <th />}
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((r) => {
                    const diff = r.diff ?? 0;
                    const tone = diff > 0 ? { color: "var(--green)" } : diff < 0 ? { color: "var(--red)" } : undefined;
                    return (
                      <tr key={r.line_id}>
                        <td>
                          <span className="strong">{label(r)}</span>
                          {h.status === "completed" && <small className="cell-sub">{r.left_out ? "Left out" : LINE_STATE[r.state]}</small>}
                          {open && r.left_out && <small className="cell-sub">Left out{r.counted === null ? "" : ": counting it again puts it back"}</small>}
                        </td>
                        {/* while counting, what a line should hold is only shown once it has been counted */}
                        {figures && <td className="num">{r.counted === null && open ? <span className="muted">Hidden</span> : r.expected === null ? "" : units(r.expected)}</td>}
                        <td className="num strong">{r.counted === null ? <span className="muted">Not counted</span> : units(r.counted)}</td>
                        {figures && <td className="num strong" style={tone}>{r.diff === null ? "" : signed(r.diff)}</td>}
                        {figures && d.may.costs && <td className="num" style={tone}>{r.value === null ? "" : (Number(r.value) > 0 ? "+" : "") + rs(Number(r.value))}</td>}
                        {open && d.may.count && (
                          <td>
                            <form action={lineAction} className="row-actions">
                              <input type="hidden" name="id" value={id} />
                              <input type="hidden" name="line" value={r.line_id} />
                              <input type="hidden" name="show" value={show} />
                              {r.counted !== null && !r.left_out && <Submit name="what" value="recount" className="btn-quiet btn-sm">Recount</Submit>}
                              {r.left_out ? (
                                <Submit name="what" value="back" className="btn-quiet btn-sm">Put back</Submit>
                              ) : (
                                <Submit name="what" value="leave" className="btn-quiet btn-sm">Leave out</Submit>
                              )}
                            </form>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {fits.length > MOST && (
                    <tr>
                      <td colSpan={6} className="muted">
                        The first {MOST} of {fits.length} lines. Scan or search a product to count it: it does not have to be on this page.
                      </td>
                    </tr>
                  )}
                  {shownRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        {show === "different" ? (totals.counted === 0 ? "Nothing is counted yet." : "Every line counted so far matches.") : "No lines here."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {open && d.may.count && (
              <form action={completeCount} className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-end", justifyContent: "space-between" }}>
                <input type="hidden" name="id" value={id} />
                <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
                  <legend className="strong" style={{ padding: "0 0 6px" }}>
                    The {totals.uncounted} {totals.uncounted === 1 ? "line" : "lines"} not counted
                  </legend>
                  <label className="check"><input type="radio" name="uncounted" value="leave" defaultChecked /><span>Leave them as they are</span></label>
                  <label className="check"><input type="radio" name="uncounted" value="zero" /><span>Set them to zero</span></label>
                </fieldset>
                <div style={{ display: "flex", gap: 28, alignItems: "flex-end" }}>
                  <div className="num"><div className="muted">Net difference</div><div className="strong" style={totals.units < 0 ? { color: "var(--red)" } : undefined}>{signed(totals.units)} {Math.abs(totals.units) === 1000 ? "unit" : "units"}</div></div>
                  {d.may.costs && <div className="num"><div className="muted">At cost</div><div className="strong" style={totals.value < 0 ? { color: "var(--red)" } : undefined}>{rs(totals.value)}</div></div>}
                  <Submit>Complete the count</Submit>
                </div>
              </form>
            )}
          </Card>
          {open && d.may.count && (
            <form action={cancelCount} className="no-print">
              <input type="hidden" name="id" value={id} />
              <span className="muted">Completing corrects the stock of every counted line and cannot be undone. </span>
              <Submit className="btn-link danger">Cancel this count</Submit>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
