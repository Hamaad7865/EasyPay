import Link from "next/link";
import { ChevronRight, Receipt } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { money } from "@/lib/settings";
import { filters, reportStart, today } from "@/lib/report";
import { pickedOf } from "@/lib/branch";
import { whatsappNumber } from "@/lib/receipt-doc";
import { Empty, Flash, one, PageHead, type Search } from "../ui";
import { Go, Submit, Wait } from "../busy";
import { BranchPicker } from "../branch-picker";
import { PaperPreview } from "../receipt-design/preview";
import { LIMIT, PLAIN, openReceipt, receiptList, type PayRow, type Row } from "./data";
import { describe } from "./reasons";
import { ReceiptPopup } from "./popup";
import { correctPayment, resolveReceipt } from "./actions";

// The receipts of the days picked, after Carfectionist's tickets (2026-11-07,
// docs/superpowers/specs/2026-11-07-receipts-popup-design.md): a line each,
// what they come to, and each one in a pop-up as the till prints it, to copy,
// send, print, correct how it was paid, and sign off.
const PATH = "/backoffice/receipts";

// how a payment names itself on the list and in the pop-up (0079, 0109, 0113, 0114)
function payName(p: { name: string | null; kind: string | null; ref: string | null }, refund: boolean): string {
  if (p.kind === "credit_note") return `Credit note ${p.ref ?? ""}`.trim();
  if (p.kind === "deposit") return `Deposit ${p.ref ?? ""}`.trim();
  if (p.kind === "account") return refund ? "Off the bill on account" : "On account";
  if (p.kind === "exchange") return refund ? "To the new sale" : `Returned goods${p.ref ? ", refund " + p.ref : ""}`;
  return p.name ?? "Unknown";
}

export default async function ReceiptsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const shop = ctx.mode === "retail";
  const q = one(sp.q).trim().slice(0, 60);
  const view: "days" | "check" | "find" = q ? "find" : one(sp.view) === "check" ? "check" : "days";
  const asked = UUID.test(one(sp.r)) ? one(sp.r) : null;
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz, (await pickedOf(l.stores))?.id ?? null);
    const may = (
      await c.query(
        `select has_perm($1, 'payment.correct') as correct, has_perm($1, 'sale.refund') as sign,
                (select mra = 'live' from tenants where id = $2) as mra_live`,
        [ctx.employeeId, ctx.tenantId],
      )
    ).rows[0] as { correct: boolean; sign: boolean; mra_live: boolean | null };
    // who may see receipts: whoever sees reports, and whoever corrects or signs them off
    if (!ok && !may.correct && !may.sign) return { l, f, s, allowed: false as const };
    const list = await receiptList(c, ctx.tenantId, { view, from: f.from, to: f.to, store: f.store, q });
    // a number looked for that only one receipt has: it opens
    const r = asked ?? (view === "find" && list.rows.length === 1 ? list.rows[0].id : null);
    const types = (
      await c.query(`select id, name, kind from payment_types where tenant_id = $1 and deleted_at is null and is_active order by sort_order, name`, [ctx.tenantId])
    ).rows as { id: string; name: string; kind: string }[];
    return { l, f, s, allowed: true as const, may, list, types, opened: r ? await openReceipt(c, ctx.tenantId, r, s, l.stores, shop) : null };
  });

  const head = (
    <PageHead title="Receipts" lede="Every receipt and refund of the days you pick. Open one to see it as the till prints it, send it, print it, or change how it was paid.">
      <BranchPicker all={d.l.stores} picked={d.f.store} />
    </PageHead>
  );
  if (!d.allowed) return <div>{head}<div className="note warn">Your role does not include seeing receipts.</div></div>;

  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const tz = d.l.tz;
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const hourOf = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const longOf = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  // the address of the list as it is: the days, the view, what was looked for; `r` opens a receipt over it
  const keep = new URLSearchParams();
  if (view === "days") {
    keep.set("from", d.f.from);
    keep.set("to", d.f.to);
  } else if (view === "check") keep.set("view", "check");
  else keep.set("q", q);
  const listHref = PATH + "?" + keep.toString();
  const openHref = (id: string) => {
    const p = new URLSearchParams(keep);
    p.set("r", id);
    return PATH + "?" + p.toString();
  };

  const { rows, totals, open } = d.list;
  const shown = rows.slice(0, LIMIT);
  const branches = d.f.store === null && d.l.stores.length > 1;
  const isToday = view === "days" && d.f.from === d.f.to && d.f.to === today(tz);
  const o = d.opened;
  const back = o ? openHref(o.id) : listHref;

  return (
    <div>
      {head}
      {!o && <Flash sp={sp} />}
      {open > 0 && view !== "check" && (
        <div className="note warn">
          <strong>{open} {open === 1 ? "receipt needs" : "receipts need"} a look</strong>
          The till took the money, or gave it back, and kept selling. <Link href={PATH + "?view=check"}>See {open === 1 ? "it" : "them"}</Link>
        </div>
      )}

      <div className="rc-bar">
        <div className="tabs rc-tabs">
          <Link href={PATH} className={view === "days" ? "on" : ""}>
            By day<Wait />
          </Link>
          <Link href={PATH + "?view=check"} className={view === "check" ? "on" : ""}>
            To check{open > 0 ? ` · ${open}` : ""}<Wait />
          </Link>
        </div>
        <Go action={PATH} className="filters rc-filters no-print">
          <label>
            From
            <input type="date" name="from" defaultValue={d.f.from} />
          </label>
          <label>
            To
            <input type="date" name="to" defaultValue={d.f.to} />
          </label>
          <Submit>Show</Submit>
          {!isToday && (
            <Link href={PATH} className="btn-quiet">
              Today<Wait />
            </Link>
          )}
          <span className="spacer" />
          <label className="rc-find">
            Receipt number
            <input type="search" name="q" defaultValue={q} placeholder="Find a number" />
          </label>
        </Go>
      </div>

      <p className="rc-sum">
        {view === "check" ? "Still to check, every day and every branch: " : view === "find" ? `Numbers with “${q}”, every day: ` : ""}
        <strong>{totals.n} {totals.n === 1 ? "receipt" : "receipts"}</strong>
        {" · "}
        {m(totals.excl)} without tax · <strong>{m(totals.incl)}</strong> in all
      </p>

      {shown.length === 0 ? (
        <Empty icon={Receipt} title={view === "check" ? "Nothing to check" : view === "find" ? "No receipt has that number" : "No receipts on these days"}>
          {view === "check" ? "Every flagged receipt has been signed off." : view === "find" ? "Check the number, or look by day." : "Pick other days. A sale on the tablet shows here within a minute."}
        </Empty>
      ) : (
        <div className="card flush table-scroll">
          <table className="rc-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>{shop ? "Sale" : "Order"}</th>
                {branches && <th>Branch</th>}
                <th>Date</th>
                <th>Time</th>
                <th>Till</th>
                <th>By</th>
                <th>Paid by</th>
                {view === "check" && <th>Why</th>}
                <th className="num">Without tax</th>
                <th className="num">Total</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r: Row) => {
                const refund = r.type === "refund";
                const sign = refund ? -1 : 1;
                const at = new Date(r.at);
                return (
                  <tr key={r.id} className={(o?.id === r.id ? "on " : "") + (r.counts ? "" : "rc-out")}>
                    <td className="strong">
                      <Link href={openHref(r.id)} scroll={false}>
                        {r.number}<Wait />
                      </Link>
                      {(refund || r.open || !r.counts) && (
                        <span className="rc-marks">
                          {refund && <span className="badge red">Refund</span>}
                          {r.open && <span className="badge amber">To check</span>}
                          {!r.counts && <span className="badge">Not counted</span>}
                        </span>
                      )}
                    </td>
                    <td>{r.order_label ? <span className="rc-chip">{r.order_label}</span> : <span className="muted">{shop ? "Sale" : "Direct sale"}</span>}</td>
                    {branches && <td>{r.store_name}</td>}
                    <td className="nowrap">{dayOf.format(at)}</td>
                    <td>{hourOf.format(at)}</td>
                    <td>{r.till ?? <span className="muted">-</span>}</td>
                    <td>{r.cashier ?? <span className="muted">Not recorded</span>}</td>
                    <td>
                      {r.payments.length === 0 ? <span className="muted">No payment</span> : r.payments.map((p) => payName(p, refund)).join(", ")}
                      {r.payments.some((p) => p.corrected) && <span className="sub">corrected</span>}
                    </td>
                    {view === "check" && (
                      <td className="rc-why">
                        {r.reviews.length === 0 ? <span className="muted">Flagged, reason not recorded</span> : r.reviews.filter((v) => !v.resolved_at).map((v) => <div key={v.reason}>{describe(v)}</div>)}
                      </td>
                    )}
                    <td className="num">{m(sign * (Number(r.total) - Number(r.tax_total)))}</td>
                    <td className="num strong">{m(sign * Number(r.total))}</td>
                    <td className="rc-go">
                      <Link href={openHref(r.id)} scroll={false} aria-label={`Open ${r.number}`}>
                        <ChevronRight aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7 + (branches ? 1 : 0) + (view === "check" ? 1 : 0)}>
                  {rows.length > LIMIT ? `The latest ${LIMIT} are shown; the figures are for all ${totals.n}. Pick fewer days to see the rest.` : ""}
                </td>
                <td className="num">{m(totals.excl)}</td>
                <td className="num strong">{m(totals.incl)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {asked && !o && <div className="note warn">That receipt is not there any more. It may have been removed.</div>}
      {o && (
        <ReceiptPopup
          key={o.id}
          title={`${o.type === "refund" ? "Refund" : "Receipt"} ${o.number}`}
          subtitle={[longOf.format(new Date(o.at)), o.store_name, o.till, o.customer?.name].filter(Boolean).join(" · ")}
          close={listHref}
          text={o.text}
          whatsapp={whatsappNumber(o.customer?.phone)}
          email={o.customer?.email ?? null}
          subject={`${o.type === "refund" ? "Refund" : "Receipt"} ${o.number}`}
          foot={
            <>
              {o.customer && (
                <Link href={`/backoffice/customers/${o.customer.id}`} className="btn-quiet">
                  {o.customer.name}&apos;s history
                </Link>
              )}
              {o.refund_of && (
                <Link href={openHref(o.refund_of.id)} scroll={false} className="btn-quiet">
                  The sale, {o.refund_of.number}<Wait />
                </Link>
              )}
            </>
          }
        >
          <div className="rc-paper">
            <PaperPreview lines={o.paper.lines} columns={48} logo={o.paper.logo} logoAt={o.paper.logoAt} logoAlign={o.paper.logoAlign} />
            <p className="muted rc-paper-note">A copy, as the till prints one{o.paper.lines.some((l) => l.t.includes("REFUNDED")) ? ", with what was refunded since" : ""}.</p>
          </div>
          <div className="rc-side">
            <Flash sp={sp} />
            <h3>{o.type === "refund" ? "Paid back by" : "Paid by"}</h3>
            {o.pays.length === 0 && <p className="muted">No payment.</p>}
            {o.pays.map((p) => (
              <Payment key={p.type} p={p} refund={o.type === "refund"} receipt={o.id} back={back} m={m}
                types={d.types} may={d.may.correct} mraLive={Boolean(d.may.mra_live)} />
            ))}
            {(o.needs_review || o.reviews.length > 0) && (
              <>
                <h3>To check</h3>
                {o.needs_review && o.reviews.length === 0 && <p><span className="badge amber">Flagged, reason not recorded</span></p>}
                {o.reviews.map((v) => (
                  <p key={v.reason} className={v.resolved_at ? "muted" : undefined}>
                    {describe(v)}
                    {v.resolved_at && ` (signed off: ${v.resolution ?? ""})`}
                  </p>
                ))}
                {o.reviews.some((v) => !v.resolved_at) &&
                  (d.may.sign ? (
                    <form action={resolveReceipt} className="rc-form">
                      <input type="hidden" name="receipt" value={o.id} />
                      <input type="hidden" name="back" value={back} />
                      <input name="note" placeholder="What was done" required aria-label="What was done" />
                      <Submit className="btn-quiet btn-sm">Sign off</Submit>
                    </form>
                  ) : (
                    <p className="muted">Signing off needs a role that may refund.</p>
                  ))}
              </>
            )}
          </div>
        </ReceiptPopup>
      )}
    </div>
  );
}

function Payment({ p, refund, receipt, back, m, types, may, mraLive }: {
  p: PayRow; refund: boolean; receipt: string; back: string; m: (v: string | number) => string;
  types: { id: string; name: string; kind: string }[]; may: boolean; mraLive: boolean;
}) {
  const plain = PLAIN.includes(p.kind ?? "");
  const to = types.filter((t) => t.id !== p.type && PLAIN.includes(t.kind));
  return (
    <div className="rc-pay">
      <div className="rc-pay-row">
        <span>{payName({ name: p.name, kind: p.kind, ref: p.reference }, refund)}</span>
        <strong>{m(p.amount)}</strong>
      </div>
      {p.was && <span className="sub">changed from {p.was}</span>}
      {may && plain && to.length > 0 &&
        (mraLive ? (
          <span className="sub">Live on MRA e-invoicing: how a sale was paid is not changed. Refund it and ring it up again.</span>
        ) : (
          <details className="rc-change">
            <summary>Change payment method</summary>
            <form action={correctPayment} className="rc-form">
              <input type="hidden" name="receipt" value={receipt} />
              <input type="hidden" name="from" value={p.type} />
              <input type="hidden" name="back" value={back} />
              <select name="to" defaultValue="" required aria-label="New payment method">
                <option value="" disabled>
                  Paid by…
                </option>
                {to.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <Submit className="btn-sm">Change</Submit>
            </form>
          </details>
        ))}
    </div>
  );
}
