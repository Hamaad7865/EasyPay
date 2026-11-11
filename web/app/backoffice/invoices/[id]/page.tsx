import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, MessageCircle, Printer, ScrollText } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { daysLate, figures, METHOD_WORDS, qtyText, stateOf, STATE_TONE, STATE_WORDS, termsWords } from "@/lib/invoice-money";
import { lineAmount, whatsappNumber } from "@/lib/receipt-doc";
import { Empty, Flash, one, PageHead, type Search } from "../../ui";
import { glance, type Glance, type Invoice, loadInvoice, loadSeries, loadSetup, numberOf, sellerOf, type Seller, type Setup, stockOf } from "../data";
import { GlanceCard } from "../glance";
import { InvoiceEditor, type Tax } from "./editor";
import { CancelPayment, PaymentPanel } from "./issued";

const PATH = "/backoffice/invoices";

type Found = {
  inv: Invoice;
  taxes: Tax[];
  staff: { id: string; name: string }[];
  branch: string | null;
  today: string;
  next: string;
  stock: Record<string, number | null>;
  glance: Glance | null;
  decimals: number;
  setup: Setup;
  seller: Seller;
};

// One invoice: a draft is written here (editor.tsx); an issued one is shown as it stands, with its payments,
// what is owed, and the ways to send it.
export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (!UUID.test(id)) notFound();
  const shop = ctx.mode === "retail";
  const d = await readTenant(ctx.tenantId, async (c) => {
    const may = (
      await c.query(`select has_perm($1, 'invoices.manage') as manage, has_perm($1, 'reports.view') as view, has_perm($1, 'costs.view') as costs`, [ctx.employeeId])
    ).rows[0] as { manage: boolean; view: boolean; costs: boolean };
    if (!may.manage && !may.view) return { may, found: null };
    const inv = await loadInvoice(c, ctx.tenantId, id);
    if (!inv) return { may, found: null };
    // what a product cost the business is for those who may see cost: never sent to anyone else's browser
    if (!may.costs) for (const l of inv.lines) l.unit_cost = null;
    const [settings, taxes, staff, today, series, setup] = await Promise.all([
      loadSettings(c, ctx.tenantId),
      c.query(`select id, name, rate_bp, type from taxes where tenant_id = $1 and deleted_at is null order by name`, [ctx.tenantId]),
      c.query(`select id, name from employees where tenant_id = $1 and deleted_at is null order by lower(name)`, [ctx.tenantId]),
      c.query(`select invoice_today($1, $2)::text as d`, [ctx.tenantId, inv.store_id]),
      loadSeries(c, ctx.tenantId),
      loadSetup(c, ctx.tenantId),
    ]);
    const keys = inv.lines.filter((l) => l.kind === "line" && l.item_id).map((l) => ({ item_id: l.item_id!, variant_id: l.variant_id }));
    const stock = inv.status === "draft" ? await stockOf(c, ctx.tenantId, inv.store_id, keys) : {};
    const g = inv.customer_id ? await glance(c, ctx.tenantId, inv.customer_id, settings.accountDays) : null;
    const s = series.find((x) => x.store_id === inv.store_id);
    const seller = await sellerOf(c, ctx.tenantId, inv.store_id, settings.company, settings.receipt.showLogo ? settings.receipt.logo : null);
    const found: Found = {
      inv,
      taxes: taxes.rows as Tax[],
      staff: staff.rows as { id: string; name: string }[],
      branch: seller.branch,
      today: today.rows[0].d as string,
      next: s ? numberOf(s.prefix, s.next_no) : "",
      stock,
      glance: g,
      decimals: settings.decimals,
      setup,
      seller,
    };
    return { may, found };
  });

  if (!d.may.manage && !d.may.view) {
    return (
      <div className="inv-page">
        <PageHead title="Invoice" />
        <Empty icon={ScrollText} title="Your role cannot see invoices">Ask the owner to tick Make and issue invoices, or See reports, on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  if (!d.found) {
    return (
      <div className="inv-page">
        <PageHead title="Invoice" />
        <Empty icon={ScrollText} title="This invoice is not here">
          It may have been a draft that was deleted. <Link href={PATH}>All invoices</Link>
        </Empty>
      </div>
    );
  }
  const f = d.found;
  const inv = f.inv;
  const back = (
    <Link href={PATH} className="btn btn-quiet">
      <ArrowLeft aria-hidden="true" />
      All invoices
    </Link>
  );

  // ---- a draft, for someone who may write it ----
  if (inv.status === "draft" && d.may.manage) {
    return (
      <div className="inv-page inv-page-ed">
        <Flash sp={sp} />
        <InvoiceEditor
          inv={inv}
          taxes={f.taxes}
          staff={f.staff}
          branch={f.branch}
          today={f.today}
          next={f.next}
          stock={f.stock}
          glance={f.glance}
          decimals={f.decimals}
          costs={d.may.costs}
          shop={shop}
          mra={ctx.mra !== "off"}
          seller={f.seller.name}
          bank={
            [f.setup.bank_name, f.setup.account_name && `Account: ${f.setup.account_name}`, f.setup.account_no && `No ${f.setup.account_no}`, f.setup.swift && `SWIFT ${f.setup.swift}`]
              .filter(Boolean)
              .join("\n") || null
          }
        />
      </div>
    );
  }

  // ---- an issued invoice (or a draft, for someone who only looks) ----
  const rs = (c: number) => money(c, f.decimals);
  const state = stateOf({ status: inv.status, total: inv.total, paid: inv.paid, due_on: inv.due }, f.today);
  const owed = inv.status === "issued" ? inv.total - inv.paid : 0;
  const late = state === "overdue" ? daysLate(inv.due, f.today) : 0;
  const fig = figures(
    inv.lines.filter((l) => l.kind === "line"),
    { type: inv.disc_type, value: inv.disc_value },
  );
  const fr = inv.lang === "fr";
  const name = inv.number ?? "Draft";
  const bank = [f.setup.bank_name, f.setup.account_name && (fr ? `Compte : ${f.setup.account_name}` : `Account: ${f.setup.account_name}`), f.setup.account_no && `No ${f.setup.account_no}`, f.setup.swift]
    .filter(Boolean)
    .join(", ");
  const message = fr
    ? [`Facture ${name} de ${f.seller.name}`, `Montant : ${rs(inv.total)}`, `À payer le ${inv.due} au plus tard`, owed > 0 && owed < inv.total && `Reste dû : ${rs(owed)}`, bank && `Paiement : ${bank}`, `Référence : ${name}`]
    : [`Invoice ${name} from ${f.seller.name}`, `Amount: ${rs(inv.total)}`, `Due by ${inv.due}`, owed > 0 && owed < inv.total && `Still owed: ${rs(owed)}`, bank && `Pay to: ${bank}`, `Reference: ${name}`];
  const text = message.filter(Boolean).join("\n");
  const wa = whatsappNumber(inv.buyer_phone);
  const waHref = `https://wa.me/${wa ?? ""}?text=${encodeURIComponent(text)}`;
  const mail = inv.buyer_email
    ? `mailto:${encodeURIComponent(inv.buyer_email)}?${[inv.buyer_cc && `cc=${encodeURIComponent(inv.buyer_cc)}`, `subject=${encodeURIComponent((fr ? "Facture " : "Invoice ") + name)}`, `body=${encodeURIComponent(text)}`].filter(Boolean).join("&")}`
    : null;
  const buyerType = inv.buyer_type === "B2B" ? "Business" : inv.buyer_type === "B2G" ? "Government" : null;

  return (
    <div className="inv-page">
      <PageHead title={inv.number ?? "Draft invoice"} lede={`${inv.buyer_name || "No customer yet"} · ${rs(inv.total)}${f.branch ? ` · ${f.branch}` : ""}`}>
        {back}
        <Link href={`${PATH}/${inv.id}/print`} target="_blank" className="btn btn-quiet">
          <Printer aria-hidden="true" />
          Print or PDF
        </Link>
        {inv.status === "issued" && (
          <a href={waHref} target="_blank" rel="noopener noreferrer" className="btn btn-quiet">
            <MessageCircle aria-hidden="true" />
            WhatsApp
          </a>
        )}
        {inv.status === "issued" && mail && (
          <a href={mail} className="btn btn-quiet">
            <Mail aria-hidden="true" />
            Email
          </a>
        )}
        {inv.status === "issued" && d.may.manage && owed > 0 && <PaymentPanel key={one(sp.ok) + one(sp.err)} id={inv.id} owed={owed} today={f.today} issued={inv.issued_on} decimals={f.decimals} />}
      </PageHead>
      <Flash sp={sp} />
      <div className="inv-view">
        <div className="inv-view-main">
          <section className="card">
            <div className="card-head">
              <div className="inv-standing">
                <span className={STATE_TONE[state]}>{STATE_WORDS[state]}</span>
                {inv.status === "issued" && (
                  <span className={late ? "inv-warn" : "muted"}>
                    {owed > 0 ? `${rs(owed)} owed, due ${inv.due}` : `Paid in full`}
                    {late > 0 && ` · ${late === 1 ? "1 day late" : `${late} days late`}`}
                  </span>
                )}
                {inv.status === "draft" && <span className="muted">Only someone who may make invoices can change or issue it.</span>}
              </div>
            </div>
            <div className="card-body inv-two">
              <div>
                <h3 className="inv-h3">Bill to{buyerType && <span className="badge inv-badge-gap">{buyerType}</span>}</h3>
                <p className="inv-lines-of">
                  <strong>{inv.buyer_name}</strong>
                  {inv.buyer_contact && <span>{fr ? "À l'attention de" : "Attention:"} {inv.buyer_contact}</span>}
                  {inv.buyer_address && <span className="inv-pre">{inv.buyer_address}</span>}
                  {inv.buyer_brn && <span>BRN {inv.buyer_brn}</span>}
                  {inv.buyer_vat && <span>VAT {inv.buyer_vat}</span>}
                  {[inv.buyer_phone, inv.buyer_email].filter(Boolean).length > 0 && <span className="muted">{[inv.buyer_phone, inv.buyer_email].filter(Boolean).join(" · ")}</span>}
                  {inv.deliver_to && <span className="muted inv-pre">Deliver to: {inv.deliver_to}</span>}
                </p>
              </div>
              <dl className="kv">
                <dt>Date</dt>
                <dd>{inv.issued_on}</dd>
                <dt>Terms</dt>
                <dd>{termsWords(inv.terms)}</dd>
                <dt>Due</dt>
                <dd>{inv.due}</dd>
                {inv.cust_ref && (
                  <>
                    <dt>Their order number</dt>
                    <dd>{inv.cust_ref}</dd>
                  </>
                )}
                {inv.our_ref && (
                  <>
                    <dt>Our reference</dt>
                    <dd>{inv.our_ref}</dd>
                  </>
                )}
                {inv.rep && (
                  <>
                    <dt>Sold by</dt>
                    <dd>{inv.rep}</dd>
                  </>
                )}
                {inv.issued_by && (
                  <>
                    <dt>Issued by</dt>
                    <dd>{inv.issued_by}</dd>
                  </>
                )}
              </dl>
            </div>
          </section>

          <section className="card flush">
            <div className="table-scroll">
              <table className="inv-read">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                    <th>Tax</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) =>
                    l.kind === "line" ? (
                      <tr key={l.id}>
                        <td>
                          {l.name}
                          {(l.detail || l.sku) && <span className="cell-sub inv-pre">{[l.sku, l.detail].filter(Boolean).join(" · ")}</span>}
                        </td>
                        <td className="num">{qtyText(l.qty)}</td>
                        <td className="num">
                          {rs(l.unit_price)}
                          {l.list_price !== null && l.list_price > l.unit_price && <span className="cell-sub">was {rs(l.list_price)}</span>}
                        </td>
                        <td className="muted">{l.taxes.map((t) => t.name).join(", ") || "No tax"}</td>
                        <td className="num">{rs(lineAmount(l.unit_price, l.qty))}</td>
                      </tr>
                    ) : (
                      <tr key={l.id} className={"inv-" + l.kind}>
                        <td colSpan={5}>{l.name}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            <div className="card-body inv-read-totals">
              <dl className="kv">
                <dt>Lines</dt>
                <dd>{rs(inv.subtotal)}</dd>
                {inv.discount_total > 0 && (
                  <>
                    <dt>Discount{inv.disc_type === "percent" ? ` ${inv.disc_value}%` : ""}</dt>
                    <dd>−{rs(inv.discount_total)}</dd>
                  </>
                )}
                {fig.taxes.filter((t) => !t.included).map((t) => (
                  <Pair key={t.key} k={`${t.name} ${t.rateBp / 100}%`} v={rs(t.amount)} />
                ))}
                <dt className="total">Total</dt>
                <dd className="total">{rs(inv.total)}</dd>
                {fig.taxes.filter((t) => t.included).map((t) => (
                  <Pair key={t.key} k={`of which ${t.name} ${t.rateBp / 100}%`} v={rs(t.amount)} sub />
                ))}
                {inv.paid > 0 && <Pair k="Paid" v={rs(inv.paid)} />}
                {inv.status === "issued" && <Pair k="Owed" v={rs(owed)} strong />}
              </dl>
            </div>
          </section>

          {inv.note && (
            <section className="card">
              <div className="card-body">
                <h3 className="inv-h3">Note</h3>
                <p className="inv-pre">{inv.note}</p>
              </div>
            </section>
          )}

          {inv.status === "issued" && (
            <section className="card flush">
              <div className="card-head">
                <div>
                  <h2>Payments</h2>
                  <p>Money received on this invoice. None of it goes through a till&rsquo;s drawer.</p>
                </div>
              </div>
              {inv.payments.length === 0 ? (
                <p className="muted inv-none">Nothing received yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="inv-pays">
                    <thead>
                      <tr>
                        <th>Received</th>
                        <th>How</th>
                        <th>Reference</th>
                        <th>Recorded by</th>
                        <th className="num">Amount</th>
                        <th aria-label="Cancel" />
                      </tr>
                    </thead>
                    <tbody>
                      {inv.payments.map((p) => (
                        <tr key={p.id} className={p.cancelled_at ? "inv-struck" : undefined}>
                          <td>{p.paid_on}</td>
                          <td>{METHOD_WORDS[p.method]?.en ?? p.method}</td>
                          <td>{p.reference ?? ""}</td>
                          <td>
                            {p.by ?? ""}
                            {p.cancelled_at && <span className="cell-sub">Cancelled{p.cancelled_by ? ` by ${p.cancelled_by}` : ""}</span>}
                          </td>
                          <td className="num">{rs(p.amount)}</td>
                          <td>{!p.cancelled_at && d.may.manage && <CancelPayment id={inv.id} payment={p.id} says={rs(p.amount)} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {inv.status === "issued" && (
            <p className="muted inv-small inv-after">
              An issued invoice cannot be changed or deleted, so its number is never reused. What was on it left {f.branch ? `${f.branch}'s` : "the"} stock when it was
              issued.
            </p>
          )}
        </div>
        <GlanceCard id={inv.customer_id} g={f.glance} today={f.today} decimals={f.decimals} shop={shop} />
      </div>
    </div>
  );
}

function Pair({ k, v, sub, strong }: { k: string; v: string; sub?: boolean; strong?: boolean }) {
  return (
    <>
      <dt className={sub ? "inv-sub" : strong ? "inv-strong" : undefined}>{k}</dt>
      <dd className={sub ? "inv-sub" : strong ? "inv-strong" : undefined}>{v}</dd>
    </>
  );
}
