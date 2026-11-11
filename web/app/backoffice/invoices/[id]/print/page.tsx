import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { exclOf, figures, METHOD_WORDS, percentOff, qtyText, termsWords } from "@/lib/invoice-money";
import { lineAmount } from "@/lib/receipt-doc";
import { PrintButton } from "../../../reports/print-button";
import { Empty, PageHead, type Search } from "../../../ui";
import { loadInvoice, loadSetup, sellerOf } from "../../data";

// An invoice on A4, as it is printed or saved as a PDF ("Save as PDF" in the print dialog): white paper with black
// ink whatever the look, in English or French as the invoice says. A draft prints with DRAFT across it and no
// number, so it can never pass for an invoice.

const WORDS = {
  en: {
    invoice: "Invoice", vatInvoice: "VAT invoice", draft: "Draft", notInvoice: "Draft: not an invoice", number: "Number", date: "Date", due: "Due",
    terms: "Terms", billTo: "Bill to", deliverTo: "Deliver to", attn: "Attention", theirRef: "Your order", ourRef: "Our reference", soldBy: "Sold by",
    desc: "Description", qty: "Qty", price: "Unit price", priceExcl: "Unit price excl. VAT", off: "Off", amount: "Amount", amountExcl: "Amount excl. VAT",
    lines: "Subtotal", discount: "Discount", total: "Total", totalExcl: "Total excl. VAT", ofWhich: "of which", paid: "Paid", owed: "Balance due",
    payTo: "Please pay to", bank: "Bank", accName: "Account name", accNo: "Account number", swift: "SWIFT / IBAN", reference: "Reference",
    payments: "Payments received", note: "Note", page: "Thank you.", branch: "Branch", tel: "Tel",
  },
  fr: {
    invoice: "Facture", vatInvoice: "Facture TVA", draft: "Brouillon", notInvoice: "Brouillon : ceci n’est pas une facture", number: "Numéro", date: "Date",
    due: "Échéance", terms: "Conditions", billTo: "Facturé à", deliverTo: "Livrer à", attn: "À l’attention de", theirRef: "Votre commande",
    ourRef: "Notre référence", soldBy: "Vendeur", desc: "Désignation", qty: "Qté", price: "Prix unitaire", priceExcl: "Prix unitaire HT", off: "Remise",
    amount: "Montant", amountExcl: "Montant HT", lines: "Sous-total", discount: "Remise", total: "Total", totalExcl: "Total HT", ofWhich: "dont",
    paid: "Payé", owed: "Reste à payer", payTo: "Paiement à", bank: "Banque", accName: "Titulaire du compte", accNo: "Numéro de compte",
    swift: "SWIFT / IBAN", reference: "Référence", payments: "Paiements reçus", note: "Note", page: "Merci.", branch: "Succursale", tel: "Tél",
  },
};

export default async function InvoicePrint({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  await searchParams;
  const ctx = await tenantContext();
  if (!UUID.test(id)) notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const may = (await c.query(`select has_perm($1, 'invoices.manage') or has_perm($1, 'reports.view') as ok`, [ctx.employeeId])).rows[0].ok as boolean;
    if (!may) return null;
    const inv = await loadInvoice(c, ctx.tenantId, id);
    if (!inv) return null;
    const settings = await loadSettings(c, ctx.tenantId);
    const [setup, seller] = await Promise.all([
      loadSetup(c, ctx.tenantId),
      sellerOf(c, ctx.tenantId, inv.store_id, settings.company, settings.receipt.showLogo ? settings.receipt.logo : null),
    ]);
    return { inv, setup, seller, decimals: settings.decimals };
  });
  if (!d) {
    return (
      <div>
        <PageHead title="Invoice" />
        <Empty icon={ArrowLeft} title="This invoice cannot be shown">It is not here, or your role cannot see invoices.</Empty>
      </div>
    );
  }
  const { inv, setup, seller } = d;
  const w = WORDS[inv.lang === "fr" ? "fr" : "en"];
  const rs = (c: number) => money(c, d.decimals);
  const draft = inv.status === "draft";
  const lines = inv.lines.filter((l) => l.kind === "line");
  const fig = figures(lines, { type: inv.disc_type, value: inv.disc_value });
  const excl = inv.show_excl;
  const anyOff = lines.some((l) => l.list_price !== null && l.list_price > l.unit_price);
  const title = draft ? w.draft : seller.vat ? w.vatInvoice : w.invoice;
  const owed = inv.total - inv.paid;
  const paid = inv.payments.filter((p) => !p.cancelled_at);
  const bank = setup.bank_name || setup.account_no;
  const cols = 4 + (anyOff ? 1 : 0);

  return (
    <div className="inv-print-wrap">
      <div className="inv-print-bar no-print">
        <Link href={`/backoffice/invoices/${inv.id}`} className="btn btn-quiet">
          <ArrowLeft aria-hidden="true" />
          Back to the invoice
        </Link>
        <PrintButton />
      </div>
      <article className={"inv-paper" + (draft ? " inv-paper-draft" : "")} lang={inv.lang}>
        {draft && <div className="inv-watermark" aria-hidden="true">{w.draft}</div>}
        <header className="inv-p-head">
          <div className="inv-p-seller">
            {seller.logo && <img src={seller.logo} alt="" className="inv-p-logo" />}
            <div className="inv-p-name">{seller.name}</div>
            {seller.legal && <div>{seller.legal}</div>}
            {seller.address && <div className="inv-pre">{seller.address}</div>}
            {seller.phone && <div>{w.tel} {seller.phone}</div>}
            {seller.brn && <div>BRN {seller.brn}</div>}
            {seller.vat && <div>VAT {seller.vat}</div>}
            {seller.branch && <div>{w.branch}: {seller.branch}</div>}
          </div>
          <div className="inv-p-title">
            <h1>{title}</h1>
            {draft ? (
              <p className="inv-p-draft">{w.notInvoice}</p>
            ) : (
              <p className="inv-p-number">{inv.number}</p>
            )}
            <dl className="inv-p-dl">
              <dt>{w.date}</dt>
              <dd>{inv.issued_on}</dd>
              <dt>{w.terms}</dt>
              <dd>{termsWords(inv.terms, inv.lang)}</dd>
              <dt>{w.due}</dt>
              <dd>{inv.due}</dd>
            </dl>
          </div>
        </header>

        <section className="inv-p-parties">
          <div className="inv-p-box">
            <div className="inv-p-label">{w.billTo}</div>
            <div className="inv-p-who">{inv.buyer_name}</div>
            {inv.buyer_contact && <div>{w.attn}: {inv.buyer_contact}</div>}
            {inv.buyer_address && <div className="inv-pre">{inv.buyer_address}</div>}
            {inv.buyer_brn && <div>BRN {inv.buyer_brn}</div>}
            {inv.buyer_vat && <div>VAT {inv.buyer_vat}</div>}
            {[inv.buyer_phone, inv.buyer_email].filter(Boolean).length > 0 && <div>{[inv.buyer_phone, inv.buyer_email].filter(Boolean).join(" · ")}</div>}
          </div>
          {inv.deliver_to && (
            <div className="inv-p-box">
              <div className="inv-p-label">{w.deliverTo}</div>
              <div className="inv-pre">{inv.deliver_to}</div>
            </div>
          )}
          {(inv.cust_ref || inv.our_ref || inv.rep) && (
            <dl className="inv-p-box inv-p-refs">
              {inv.cust_ref && (
                <>
                  <dt>{w.theirRef}</dt>
                  <dd>{inv.cust_ref}</dd>
                </>
              )}
              {inv.our_ref && (
                <>
                  <dt>{w.ourRef}</dt>
                  <dd>{inv.our_ref}</dd>
                </>
              )}
              {inv.rep && (
                <>
                  <dt>{w.soldBy}</dt>
                  <dd>{inv.rep}</dd>
                </>
              )}
            </dl>
          )}
        </section>

        <table className="inv-p-lines">
          <thead>
            <tr>
              <th>{w.desc}</th>
              <th className="num">{w.qty}</th>
              <th className="num">{excl ? w.priceExcl : w.price}</th>
              {anyOff && <th className="num">{w.off}</th>}
              <th className="num">{excl ? w.amountExcl : w.amount}</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => {
              if (l.kind === "heading") return (
                <tr key={l.id} className="inv-p-heading">
                  <td colSpan={cols}>{l.name}</td>
                </tr>
              );
              if (l.kind === "note") return (
                <tr key={l.id} className="inv-p-note">
                  <td colSpan={cols}>{l.name}</td>
                </tr>
              );
              const amount = lineAmount(l.unit_price, l.qty);
              const off = l.list_price !== null ? percentOff(l.list_price, l.unit_price) : 0;
              return (
                <tr key={l.id}>
                  <td>
                    {l.name}
                    {(l.sku || l.detail) && <div className="inv-p-sub inv-pre">{[l.sku, l.detail].filter(Boolean).join(" · ")}</div>}
                  </td>
                  <td className="num">{qtyText(l.qty)}</td>
                  <td className="num">{rs(excl ? exclOf(off ? l.list_price! : l.unit_price, l.taxes) : off ? l.list_price! : l.unit_price)}</td>
                  {anyOff && <td className="num">{off ? `${off / 100}%` : ""}</td>}
                  <td className="num">{rs(excl ? exclOf(amount, l.taxes) : amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="inv-p-foot">
          <div className="inv-p-left">
            {inv.note && (
              <div className="inv-p-block">
                <div className="inv-p-label">{w.note}</div>
                <div className="inv-pre">{inv.note}</div>
              </div>
            )}
            {bank && !draft && (
              <div className="inv-p-block">
                <div className="inv-p-label">{w.payTo}</div>
                {setup.bank_name && <div>{w.bank}: {setup.bank_name}</div>}
                {setup.account_name && <div>{w.accName}: {setup.account_name}</div>}
                {setup.account_no && <div>{w.accNo}: {setup.account_no}</div>}
                {setup.swift && <div>{w.swift}: {setup.swift}</div>}
                <div>{w.reference}: {inv.number}</div>
              </div>
            )}
            {paid.length > 0 && (
              <div className="inv-p-block">
                <div className="inv-p-label">{w.payments}</div>
                {paid.map((p) => (
                  <div key={p.id}>
                    {p.paid_on} · {METHOD_WORDS[p.method]?.[inv.lang === "fr" ? "fr" : "en"] ?? p.method}
                    {p.reference ? ` · ${p.reference}` : ""} · {rs(p.amount)}
                  </div>
                ))}
              </div>
            )}
          </div>
          <dl className="inv-p-totals">
            {excl ? (
              <>
                <dt>{w.totalExcl}</dt>
                <dd>{rs(inv.total - inv.tax_total)}</dd>
                {fig.taxes.map((t) => (
                  <Row key={t.key} k={`${t.name} ${t.rateBp / 100}%`} v={rs(t.amount)} />
                ))}
                {inv.discount_total > 0 && <Row k={`${w.discount}${inv.disc_type === "percent" ? ` ${inv.disc_value}%` : ""}`} v={"−" + rs(inv.discount_total)} note />}
              </>
            ) : (
              <>
                <dt>{w.lines}</dt>
                <dd>{rs(inv.subtotal)}</dd>
                {inv.discount_total > 0 && <Row k={`${w.discount}${inv.disc_type === "percent" ? ` ${inv.disc_value}%` : ""}`} v={"−" + rs(inv.discount_total)} />}
                {fig.taxes.filter((t) => !t.included).map((t) => (
                  <Row key={t.key} k={`${t.name} ${t.rateBp / 100}%`} v={rs(t.amount)} />
                ))}
              </>
            )}
            <dt className="inv-p-total">{w.total}</dt>
            <dd className="inv-p-total">{rs(inv.total)}</dd>
            {!excl && fig.taxes.filter((t) => t.included).map((t) => (
              <Row key={t.key} k={`${w.ofWhich} ${t.name} ${t.rateBp / 100}%`} v={rs(t.amount)} note />
            ))}
            {!draft && inv.paid > 0 && <Row k={w.paid} v={rs(inv.paid)} />}
            {!draft && inv.paid > 0 && <Row k={w.owed} v={rs(owed)} strong />}
          </dl>
        </div>

        {setup.footer && <footer className="inv-p-footer inv-pre">{setup.footer}</footer>}
      </article>
    </div>
  );
}

function Row({ k, v, note, strong }: { k: string; v: string; note?: boolean; strong?: boolean }) {
  const c = note ? "inv-p-of" : strong ? "inv-p-strong" : undefined;
  return (
    <>
      <dt className={c}>{k}</dt>
      <dd className={c}>{v}</dd>
    </>
  );
}
