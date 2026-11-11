import { lineAmount, lineTax } from "./receipt-doc";

// An invoice's figures, by the till's own rules (docs/superpowers/specs/2026-11-12-invoices-design.md §2.1):
// what the editor shows as it is typed. The server works them out again in SQL (0159 invoice_figures) when a
// draft is saved and when it is issued, and keeps those; db/tests/invoices.test.cjs holds the two to the
// same figures, and to a receipt the real till push makes of the same lines.
// Money is cents, quantities thousandths (3 units is 3000). Pure: node web/lib/invoice-money.test.mjs.

export type InvTax = { tax_id: string | null; name: string; rate_bp: number; type: string };
export type MoneyLine = { qty: number; unit_price: number; taxes: InvTax[] };
export type Disc = { type: "amount" | "percent"; value: number };
export type TaxRow = { key: string; name: string; rateBp: number; included: boolean; amount: number };
export type Figures = {
  subtotal: number;
  discount: number;
  taxAdded: number;
  taxIncluded: number;
  taxTotal: number;
  total: number;
  // the tax tax by tax, as the invoice prints it
  taxes: TaxRow[];
  // each line after its share of the discount, before tax added on top
  nets: number[];
};

// The discount on the whole invoice: a percent as a receipt takes one (0..100, rounded), an amount never
// more than the lines come to.
export function discountOf(sub: number, d: Disc): number {
  const v = Math.max(0, Math.floor(d.value));
  const amt = d.type === "percent" ? Math.floor((sub * Math.min(v, 100) + 50) / 100) : Math.min(v, sub);
  return Math.max(0, Math.min(amt, sub));
}

// A line's share of the discount, disc*base/sub truncated: in whole numbers, so a large invoice keeps every cent.
const shareOf = (disc: number, base: number, sub: number) => (sub > 0 ? Number((BigInt(disc) * BigInt(base)) / BigInt(sub)) : 0);

export function figures(lines: MoneyLine[], d: Disc): Figures {
  const bases = lines.map((l) => lineAmount(l.unit_price, l.qty));
  const subtotal = bases.reduce((s, b) => s + b, 0);
  const discount = discountOf(subtotal, d);
  let taxAdded = 0;
  let taxIncluded = 0;
  const rows = new Map<string, TaxRow>();
  const nets = lines.map((l, i) => {
    const net = bases[i] - shareOf(discount, bases[i], subtotal);
    for (const t of l.taxes) {
      const amount = lineTax(net, t);
      if (t.type === "added") taxAdded += amount;
      else taxIncluded += amount;
      const key = t.tax_id ?? `${t.name}|${t.rate_bp}|${t.type}`;
      const cur = rows.get(key);
      rows.set(key, { key, name: t.name, rateBp: t.rate_bp, included: t.type !== "added", amount: (cur?.amount ?? 0) + amount });
    }
    return net;
  });
  return {
    subtotal,
    discount,
    taxAdded,
    taxIncluded,
    taxTotal: taxAdded + taxIncluded,
    total: subtotal - discount + taxAdded,
    taxes: [...rows.values()],
    nets,
  };
}

// A price shown without the tax that is inside it (the "without VAT" view): display only, the figures do
// not change. Tax added on top is not in the price, so the price is shown as it is.
export function exclOf(price: number, taxes: InvTax[]): number {
  return price - taxes.filter((t) => t.type !== "added").reduce((s, t) => s + lineTax(price, t), 0);
}

// A line's discount is a lower price, as the till changes one: the catalog price less a percent
// (basis points, 1250 = 12.5%), rounded as a receipt's percent is.
export const priceAfter = (list: number, bp: number) => list - Math.floor((list * Math.max(0, Math.min(bp, 10000)) + 5000) / 10000);
// and the percent a lower price stands for, to two decimals (basis points)
export const percentOff = (list: number, price: number) => (list > 0 && price < list ? Math.round(((list - price) * 10000) / list) : 0);

// ---- terms and where an invoice stands ----

export const TERMS = ["receipt", "7", "15", "30", "45", "60", "eom", "date"] as const;
export type Terms = string;

// the terms in words, on the page and on paper (English or French)
export function termsWords(t: Terms, lang: "en" | "fr" = "en"): string {
  const fr = lang === "fr";
  if (t === "receipt") return fr ? "À réception" : "On receipt";
  if (t === "eom") return fr ? "Fin de mois" : "End of the month";
  if (t === "date") return fr ? "À la date indiquée" : "On a set date";
  const n = Number(t);
  return Number.isInteger(n) ? (fr ? `${n} jours` : `${n} days`) : t;
}

// when a bill on these terms falls due (0159 invoice_due); days are "YYYY-MM-DD"
export function dueOf(issued: string, terms: Terms, typed: string | null): string {
  if (terms === "receipt") return issued;
  const [y, m, d] = issued.split("-").map(Number);
  if (terms === "eom") return iso(new Date(Date.UTC(y, m, 0)));
  if (terms === "date") return typed && typed >= issued ? typed : issued;
  const n = Number(terms);
  return Number.isInteger(n) ? iso(new Date(Date.UTC(y, m - 1, d + n))) : issued;
}
const iso = (t: Date) => t.toISOString().slice(0, 10);

// how a payment came in (0159 invoice_pay), on the page and on paper; none of it goes through a till's drawer
export const METHODS = ["bank", "cheque", "cash", "card", "mobile", "other"] as const;
export const METHOD_WORDS: Record<string, { en: string; fr: string }> = {
  bank: { en: "Bank transfer", fr: "Virement" },
  cheque: { en: "Cheque", fr: "Chèque" },
  cash: { en: "Cash", fr: "Espèces" },
  card: { en: "Card", fr: "Carte" },
  mobile: { en: "Mobile money", fr: "Paiement mobile" },
  other: { en: "Other", fr: "Autre" },
};

export type InvoiceState = "draft" | "issued" | "part" | "overdue" | "paid";
export const STATE_WORDS: Record<InvoiceState, string> = { draft: "Draft", issued: "Not paid yet", part: "Partly paid", overdue: "Overdue", paid: "Paid" };
export const STATE_TONE: Record<InvoiceState, string> = { draft: "badge", issued: "badge blue", part: "badge amber", overdue: "badge red", paid: "badge green" };

// Stored: draft or issued. The rest is worked out, so it can never disagree with the payments: what is
// paid in full is paid, what is still owed after its due day is overdue, a part paid is partly paid.
export function stateOf(i: { status: string; total: number; paid: number; due_on: string | null }, today: string): InvoiceState {
  if (i.status !== "issued") return "draft";
  if (i.total - i.paid <= 0) return "paid";
  if (i.due_on && i.due_on < today) return "overdue";
  return i.paid > 0 ? "part" : "issued";
}

// how many days late, for the list
export function daysLate(due: string | null, today: string): number {
  if (!due || due >= today) return 0;
  return Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(due + "T00:00:00Z")) / 86400000);
}

// ---- quantities ----

// what a person types as a quantity (2, 2.5, 0.25, "1,5" the French way) in thousandths; null when not one
export function parseQty(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{0,3})?$/.test(t) && !/^\.\d{1,3}$/.test(t)) return null;
  const [a, b = ""] = t.split(".");
  return Number(a || "0") * 1000 + Number(b.padEnd(3, "0"));
}
export const qtyText = (q: number) => (q % 1000 === 0 ? String(q / 1000) : (q / 1000).toFixed(3).replace(/0+$/, ""));

// a line no larger than the figures can hold exactly (price × quantity well inside 2^53)
export const LINE_MAX = 9_000_000_000_000_000;
export const lineFits = (price: number, qty: number) => price >= 0 && qty >= 0 && price * qty <= LINE_MAX;
