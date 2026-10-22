import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileCheck } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { basics } from "@/lib/report";
import { money, withDefaults } from "@/lib/settings";
import { MRA_STATE_WORDS, onMra, testAtMra, tillConnected } from "@/lib/mra";
import {
  attention, INVOICES_SQL, invoiceParams, MRA_TYPES, type MraInvoiceRow, mraFilters, mraQuery, type MraTillRow, reasons,
  signedCents, STATUS_FILTERS, statusWords, TILLS_SQL,
} from "@/lib/mra-page";
import { Card, Empty, one, PageHead, type Search } from "../ui";

const PATH = "/backoffice/mra";
const MOST = 200;
// what a till last said of itself (pos_devices.mra_status, 0132)
type Reported = { connected?: boolean; refused?: string | null; environment?: string | null; at?: string; until?: string } | null;

// MRA e-invoicing, for a client on Premium MRA: each till's connection to the
// MRA, and every invoice the tills sent with the MRA's answer. The back office
// only knows what a till said at its last sync, so a till's line says when that
// was. Read-only: an invoice is sent, and sent again, by its till.
export default async function MraPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (!onMra(ctx.mra)) notFound();
  const f = mraFilters((k) => one(sp[k]));
  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    if (!b.ok) return { ok: false as const };
    const [tills, invoices] = await Promise.all([c.query(TILLS_SQL, [ctx.tenantId]), c.query(INVOICES_SQL, invoiceParams(ctx.tenantId, f, MOST + 1, true))]);
    return { ok: true as const, decimals: withDefaults(b.settings).decimals, tills: tills.rows as MraTillRow[], invoices: invoices.rows as MraInvoiceRow[] };
  });
  const head = (
    <PageHead
      title="MRA e-invoicing"
      lede="What your tills send to the MRA: whether each till is connected, and every invoice with the MRA's answer. Nothing here changes what was sent."
    >
      <span className={ctx.mra === "live" ? "badge green" : "badge amber"}>{MRA_STATE_WORDS[ctx.mra]}</span>
    </PageHead>
  );
  if (!d.ok) {
    return (
      <div>
        {head}
        <Empty icon={FileCheck} title="Your role cannot see reports">Ask the owner to tick See reports on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const now = new Date();
  const at = (iso: string | null | undefined, tz: string) =>
    iso ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null;
  const tills = d.tills.map((t) => {
    const s = (t.status ?? null) as Reported;
    const why = attention(
      {
        connected: tillConnected(s),
        refusedLogin: s?.refused ?? null,
        waiting: t.waiting,
        oldestWaiting: t.oldest_waiting ? new Date(t.oldest_waiting) : null,
        check: t.to_check,
        countedAsTest: testAtMra(ctx.mra, s),
      },
      now,
    );
    return { ...t, s, why };
  });
  const worried = tills.filter((t) => t.why.length > 0);
  const branches = [...new Set(tills.map((t) => t.store))];
  const stores = [...new Map(d.tills.map((t) => [t.store_id, t])).values()];
  const shown = d.invoices.slice(0, MOST);
  const filtered = Boolean(f.store || f.till || f.type || f.status || f.from || f.to);
  return (
    <div>
      {head}
      {worried.length > 0 && (
        <Card title="Needs attention">
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            {worried.map((t) => (
              <li key={t.id}>
                <strong>
                  {t.name} ({t.code})
                </strong>
                {branches.length > 1 ? `, ${t.store}` : ""}: {t.why.join(". ")}.
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Tills" lede="Each till as it said at its last sync.">
        {tills.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No till is set up yet.</p>
        ) : (
          branches.map((branch) => (
            <div key={branch} style={{ marginBottom: 12 }}>
              {branches.length > 1 && <h3 style={{ margin: "0 0 6px" }}>{branch}</h3>}
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {tills
                  .filter((t) => t.store === branch)
                  .map((t) => (
                    <li key={t.id}>
                      <strong>
                        {t.name} ({t.code})
                      </strong>{" "}
                      <span className={tillConnected(t.s) ? "badge green" : t.s?.refused ? "badge red" : "badge amber"}>
                        {tillConnected(t.s) ? "Connected" : t.s?.refused ? "Login refused" : "Not connected"}
                      </span>
                      {testAtMra(ctx.mra, t.s) && (
                        <>
                          {" "}
                          <span className="badge red">Counted as TEST by the MRA</span>
                        </>
                      )}
                      <div className="muted">
                        {!t.ebs && "No EBS MRA ID yet: EasyPay types it in. "}
                        {t.s?.until && `Signed in until ${at(t.s.until, t.tz)}, `}
                        {t.s?.at ? `as of its sync at ${at(t.s.at, t.tz)}. ` : "It has not reported yet. "}
                        {t.waiting > 0 ? `${t.waiting} waiting. ` : "Nothing waiting. "}
                        {t.last_fiscalised && `Last fiscalised ${at(t.last_fiscalised, t.tz)}. `}
                        {t.refused > 0 && `${t.refused} refused by the MRA.`}
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))
        )}
      </Card>
      <Card>
        <form method="get" action={PATH} className="bo-toolbar" style={{ margin: 0 }}>
          {stores.length > 1 && (
            <select name="store" defaultValue={f.store ?? ""} aria-label="Branch">
              <option value="">Every branch</option>
              {stores.map((t) => (
                <option key={t.store_id} value={t.store_id}>
                  {t.store}
                </option>
              ))}
            </select>
          )}
          <select name="till" defaultValue={f.till ?? ""} aria-label="Till">
            <option value="">Every till</option>
            {d.tills.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.code})
              </option>
            ))}
          </select>
          <select name="type" defaultValue={f.type ?? ""} aria-label="Type">
            <option value="">Every type</option>
            {Object.entries(MRA_TYPES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={f.status ?? ""} aria-label="Status">
            <option value="">Every status</option>
            {Object.entries(STATUS_FILTERS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            From <input type="date" name="from" defaultValue={f.from ?? ""} />
          </label>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            to <input type="date" name="to" defaultValue={f.to ?? ""} />
          </label>
          <button type="submit" className="btn-sm">Show</button>
          {filtered && <Link href={PATH}>Show everything</Link>}
          <a href={`${PATH}/export${mraQuery(f)}`} className="btn btn-quiet btn-sm" download style={{ marginLeft: "auto" }}>
            <Download aria-hidden="true" />
            Download CSV
          </a>
        </form>
      </Card>
      {shown.length === 0 ? (
        <Empty icon={FileCheck} title={filtered ? "No invoice fits" : "Nothing sent to the MRA yet"}>
          {filtered ? "Widen the dates or choose Show everything." : "Each sale, refund or training sale of a till on MRA leaves a line here."}
        </Empty>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Branch</th>
                  <th>Till</th>
                  <th>Number</th>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const cents = signedCents(r.type, r.paid);
                  const why = reasons(r.errors);
                  const warned = reasons(r.warnings);
                  return (
                    <tr key={r.id}>
                      <td>{at(r.at, r.tz)}</td>
                      <td>{r.store}</td>
                      <td>{r.till}</td>
                      <td className="strong">
                        {r.identifier}
                        {r.ref && <div className="muted">for {r.ref}</div>}
                      </td>
                      <td>{MRA_TYPES[r.type as keyof typeof MRA_TYPES] ?? r.type}</td>
                      <td className="num">{cents === null ? "" : money(cents, d.decimals)}</td>
                      <td>
                        <details>
                          <summary>
                            <span className={r.status === "fiscalised" ? "badge green" : r.status === "refused" ? "badge red" : "badge amber"}>{statusWords(r.status)}</span>
                          </summary>
                          <div style={{ display: "grid", gap: 6, paddingTop: 8 }}>
                            {r.irn && <span className="muted">IRN {r.irn}</span>}
                            {/* the MRA's own PNG, as it came back: nothing for next/image to resize */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {r.qr && <img src={`data:image/png;base64,${r.qr}`} alt={`QR code of ${r.identifier}`} width={96} height={96} />}
                            {why && <span>The MRA said: {why}</span>}
                            {warned && <span className="muted">Warnings: {warned}</span>}
                            {r.differs !== null && r.differs !== undefined && <span className="muted">The receipt&apos;s total differs from what was sent; the MRA holds what was sent.</span>}
                            {(r.status === "unsure" || r.status === "check") && <span className="muted">The till sends it again, or check it there under Settings, MRA.</span>}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d.invoices.length > MOST && (
            <p className="muted" style={{ padding: "12px 20px", margin: 0 }}>
              These are the latest {MOST}. Narrow the dates, or download the CSV for all of them.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
