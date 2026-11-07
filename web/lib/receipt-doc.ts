import type { DocAddon, DocLine, ReceiptDoc, Shop, Styled } from "./papers";

type DocTax = NonNullable<ReceiptDoc["taxes"]>[number];

// A receipt as the till printed it, put together again from what the server
// keeps (docs/superpowers/specs/2026-11-07-receipts-popup-design.md). The tablet
// keeps the paper it printed (ReceiptEntity.doc) on the tablet; the server has
// the receipt's figures and lines, and these are the till's own rules for
// turning them into a paper (DocBuilder.receipt, OrderOps.marked).
// Nothing here reads the database: web/app/backoffice/receipts/data.ts does.

export type Head = {
  number: string;
  type: string;
  at: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  service_charge: number;
  rounding: number;
  total: number;
  // the order: its table, its number ("A-05"), who it is for, its remark and delivery details
  table_id: string | null;
  table_name: string | null;
  order_no: string | null;
  order_name: string | null;
  note: string | null;
  phone: string | null;
  address: string | null;
  covers: number | null;
  dining: string | null;
  cashier: string | null;
  waiter: string | null;
  customer: string | null;
  // a refund: the number of the sale it gives back
  refund_number: string | null;
  points_earned: number;
  points_used: number;
  // a sale: what has been refunded of it since
  refunded: number;
};
export type Tax = { tax_id: string | null; name: string; rate_bp: number; type: string };
export type Line = {
  name: string;
  unit_price: number;
  qty: number;
  list_price: number | null;
  price_label: string | null;
  addons: { name: string; qty: number; price: number }[];
  taxes: Tax[];
};
export type Disc = { name: string; amount: number };
export type Pay = { name: string | null; amount: number; tendered: number | null; change: number; reference: string | null };

// what a line charges, as the till and the server round it (Calc.lineAmount)
export const lineAmount = (price: number, qty: number) => Math.floor((price * qty + 500) / 1000);

// "Table 4" for a table named 4; a table with a name keeps it (tableLabel)
export const tableLabel = (name: string) => (/^\d/.test(name) ? `Table ${name}` : name);

// The table; else the order's number and who it is for; else a direct sale (DocBuilder.orderName).
export function orderName(h: Pick<Head, "table_name" | "order_no" | "order_name" | "customer">): string {
  if (h.table_name) return tableLabel(h.table_name);
  const who = h.order_name || h.customer;
  return [h.order_no, who].filter((x): x is string => !!x).join(" · ") || "Direct sale";
}

// The number a restaurant's order with no table prints large ("05" of "A-05"); a shop prints none (CustomerNumber.onPaper).
export function customerNo(orderNo: string | null, tableId: string | null, retail: boolean): string | null {
  if (retail || tableId) return null;
  const d = (orderNo ?? "").includes("-") ? (orderNo ?? "").slice((orderNo ?? "").lastIndexOf("-") + 1) : "";
  return d !== "" && /^\d+$/.test(d) ? d : null;
}

// The remark, and for a takeaway or delivery who to ring and where it goes (kitchenRemark).
export function remark(h: Pick<Head, "note" | "phone" | "address">): string | null {
  const parts = [h.note, h.phone ? `Tel ${h.phone}` : null, h.address].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : null;
}

// The tax in the lines, tax by tax, after each line's share of the discount: the
// sum the server and the till make (0049 push_receipt_create, DocBuilder.taxes).
// What their rounding leaves over goes on the largest, so the lines add up to the
// receipt's stored tax. A receipt whose lines say nothing of tax has one line,
// as the till's own copy of such a receipt has.
export function taxLines(lines: Line[], h: Pick<Head, "subtotal" | "discount_total" | "tax_total" | "service_charge" | "rounding" | "total">): DocTax[] {
  const bases = lines.map((l) => lineAmount(l.unit_price, l.qty) + l.addons.reduce((s, a) => s + a.price, 0));
  const sub = bases.reduce((s, b) => s + b, 0);
  const out = new Map<string, DocTax>();
  lines.forEach((l, i) => {
    const net = bases[i] - (sub > 0 ? Math.floor((h.discount_total * bases[i]) / sub) : 0);
    for (const t of l.taxes) {
      const amount =
        t.type === "added" ? Math.floor((net * t.rate_bp + 5000) / 10000) : Math.floor((net * t.rate_bp + Math.floor((10000 + t.rate_bp) / 2)) / (10000 + t.rate_bp));
      const key = t.tax_id ?? `${t.name}|${t.rate_bp}|${t.type}`;
      const cur = out.get(key);
      out.set(key, { name: t.name, rateBp: t.rate_bp, amount: (cur?.amount ?? 0) + amount, included: t.type !== "added" });
    }
  });
  const taxes = [...out.values()];
  if (taxes.length === 0) {
    if (h.tax_total === 0) return [];
    // tax that went on top of the prices is in the total; tax inside them is not
    const onTop = h.total - (h.subtotal - h.discount_total + h.service_charge + h.rounding);
    return [{ name: "Tax", rateBp: 0, amount: h.tax_total, included: onTop === 0 }];
  }
  const left = h.tax_total - taxes.reduce((s, t) => s + t.amount, 0);
  if (left !== 0) {
    const big = taxes.reduce((a, b) => (b.amount > a.amount ? b : a));
    big.amount += left;
  }
  return taxes;
}

function docLine(l: Line): DocLine {
  const adds = l.addons.reduce((s, a) => s + a.price, 0);
  return {
    qty: l.qty,
    name: l.name,
    amount: lineAmount(l.unit_price, l.qty) + adds,
    addons: l.addons.map((a): DocAddon => ({ name: a.name, qty: a.qty, price: a.price })),
    unit: l.unit_price,
    was: l.list_price === null ? null : lineAmount(l.list_price, l.qty) + adds,
    priceNote: l.price_label,
  };
}

// The receipt as a copy of it prints: marked COPY, with what has been refunded
// of it since, and without what the customer owed on account or held in points
// that day, which is not what they owe or hold now (OrderOps.marked). A copy
// that reads like the first paper is what someone would bring back to be
// refunded a second time.
export function receiptDoc(h: Head, lines: Line[], discounts: Disc[], payments: Pay[], retail: boolean): ReceiptDoc {
  const refund = h.type === "refund";
  const ms = Date.parse(h.at);
  return {
    kind: refund ? "refund" : "receipt",
    number: h.number,
    time: Number.isFinite(ms) ? ms : 0,
    order: orderName(h),
    dining: retail ? null : h.dining,
    customer: h.customer,
    cashier: h.cashier,
    waiter: retail ? null : h.waiter,
    covers: retail ? null : h.covers,
    note: remark(h),
    lines: lines.map(docLine),
    subtotal: h.subtotal,
    discounts: discounts.map((d) => ({ name: d.name, amount: d.amount })),
    taxes: taxLines(lines, h),
    service: h.service_charge,
    rounding: h.rounding,
    total: h.total,
    payments: payments.map((p) => ({ name: p.name ?? "Paid", amount: p.amount, tendered: p.tendered, change: p.change, reference: p.reference })),
    refundOf: refund ? h.refund_number : null,
    customerNo: refund ? null : customerNo(h.order_no, h.table_id, retail),
    // a sale's points earned; a refund's points taken back and given back (both at most 0 on the server)
    pointsEarned: refund ? null : h.points_earned,
    pointsTaken: refund ? -h.points_earned : null,
    pointsBack: refund ? -h.points_used : null,
    pointsBalance: null,
    owed: null,
    reprint: true,
    refunded: refund ? 0 : h.refunded,
    refundedAll: !refund && h.refunded > 0 && h.refunded >= h.total,
  };
}

// The business as its papers name it (PosSettings.shop). With two or more
// branches a paper names the branch and gives its own address and phone, the
// company's where it has none. The name, BRN and VAT number fall back to what
// the account itself holds, as Receipt design's preview does.
export function shopOf(
  s: { company: { name: string; address: string; phone: string; brn: string; vat: string }; receipt: { header: string; footer: string } },
  account: { name: string | null; brn: string | null; vat: string | null },
  branch: { name: string; address: string | null; phone: string | null } | null,
  many: boolean,
  retail: boolean,
): Shop {
  const b = many ? branch : null;
  return {
    name: s.company.name || account.name || "",
    address: b?.address?.trim() ? b.address : s.company.address,
    phone: b?.phone?.trim() ? b.phone : s.company.phone,
    brn: s.company.brn || account.brn || "",
    vat: s.company.vat || account.vat || "",
    header: s.receipt.header,
    footer: s.receipt.footer,
    bars: retail,
    branch: b?.name ?? "",
  };
}

// The paper as text, to copy or to send: its lines as they print, the barcode
// as its number. Each line keeps its place across, as the till lays it out;
// text has no large letters, so a Big line is placed across the whole width.
export function paperText(lines: Styled[], columns: number): string {
  return lines
    .filter((l) => l.bars === undefined)
    .map((l) => {
      const width = columns;
      const t = l.t;
      if (l.align === "center") return (" ".repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t).trimEnd();
      if (l.align === "right") return t.padStart(width);
      return t;
    })
    .join("\n");
}

// A phone number as WhatsApp takes it: digits with the country in front. A
// Mauritian number written without it (7 or 8 digits) gets 230.
export function whatsappNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 7) return null;
  return d.length <= 8 ? "230" + d : d.replace(/^00/, "");
}
