// How the receipt and the kitchen ticket are laid out: a column of blocks,
// made on Receipt design and kept in the settings under `papers`
// (docs/superpowers/specs/2026-10-15-receipt-designer-design.md). This is the
// till's printing (core/print/Papers.kt, PaperWalk.kt, EscPos.kt) written
// again for the page's preview, line for line: the shared examples in
// db/tests/fixtures/papers hold the two together (`node web/lib/papers.test.mjs`
// here, PapersFixtureTest on the till). Pure, with no imports, so Node can
// run it as it is.

export type Size = "normal" | "tall" | "big";
export type Align = "left" | "center" | "right";
export type PaperKind = "receipt" | "kitchen";

export type Block = {
  k: string;
  hide: boolean;
  size: Size;
  bold: boolean;
  align: Align;
  above: boolean;
  text: string;
  ch: string;
  n: number;
  addons: string;
  addonPrices: boolean;
  unitPrice: boolean;
  notes: boolean;
  was: boolean;
  seat: boolean;
};
export type Design = { blocks: Block[] };

// one line of the paper as it comes out
export type Styled = { t: string; size: Size; bold: boolean; align: Align; bars?: string };

export type DocAddon = { name: string; qty?: number; price?: number };
export type DocLine = {
  qty: number;
  name: string;
  amount: number;
  mods?: string[];
  note?: string | null;
  course?: number | null;
  seat?: number | null;
  was?: number | null;
  priceNote?: string | null;
  addons?: DocAddon[];
  unit?: number | null;
};
export type ReceiptDoc = {
  kind?: string;
  number?: string;
  time?: number;
  order?: string;
  dining?: string | null;
  cashier?: string | null;
  waiter?: string | null;
  covers?: number | null;
  note?: string | null;
  lines?: DocLine[];
  subtotal?: number;
  discounts?: { name: string; amount: number }[];
  taxes?: { name: string; rateBp: number; amount: number; included: boolean }[];
  rounding?: number;
  total?: number;
  payments?: { name: string; amount: number; tendered?: number | null; change?: number; reference?: string | null }[];
  service?: number;
  refundOf?: string | null;
  reason?: string | null;
  customer?: string | null;
  share?: number | null;
  shares?: number | null;
  reprint?: boolean;
  refunded?: number;
  refundedAll?: boolean;
  customerNo?: string | null;
};
export type KitchenDoc = {
  title: string;
  order: string;
  time: number;
  waiter?: string | null;
  dining?: string | null;
  covers?: number | null;
  note?: string | null;
  lines: DocLine[];
  station: string;
  pickup?: string | null;
  customerNo?: string | null;
};
export type Shop = { name: string; address: string; phone: string; brn: string; vat: string; header: string; footer: string; bars: boolean };

export const VERSION = 1;
export const MOST = 60;
export const TEXT = 300;
export const REPEATABLE = ["text", "line", "space"];
export const LOCKED: Record<PaperKind, string[]> = { receipt: ["title", "items", "total"], kitchen: ["items"] };

const BASE: Block = {
  k: "",
  hide: false,
  size: "normal",
  bold: false,
  align: "left",
  above: false,
  text: "",
  ch: "-",
  n: 1,
  addons: "line",
  addonPrices: false,
  unitPrice: false,
  notes: true,
  was: true,
  seat: true,
};
const kind = (k: string, o: Partial<Block> = {}): Block => ({ ...BASE, ...o, k });
const kinds = (...b: Block[]): Record<string, Block> => Object.fromEntries(b.map((x) => [x.k, x]));

// Each kind with EasyPay's settings for it.
export const KINDS: Record<PaperKind, Record<string, Block>> = {
  receipt: kinds(
    kind("logo", { align: "center" }),
    kind("name", { align: "center", size: "big" }),
    kind("address", { align: "center" }),
    kind("phone", { align: "center" }),
    kind("brn", { align: "center" }),
    kind("vat", { align: "center" }),
    kind("header", { align: "center" }),
    kind("title", { align: "center", bold: true }),
    kind("customer_no", { align: "center", bold: true, size: "big" }),
    kind("receipt_no"),
    kind("date_order"),
    kind("order_type"),
    kind("served_by"),
    kind("guests"),
    kind("customer"),
    kind("refund_of"),
    kind("items"),
    kind("subtotal"),
    kind("discounts"),
    kind("service"),
    kind("taxes"),
    kind("rounding"),
    kind("total", { bold: true, size: "tall" }),
    kind("share", { bold: true, above: true }),
    kind("payments"),
    kind("bill_note", { align: "center", above: true }),
    kind("remark", { above: true }),
    kind("footer", { align: "center", above: true }),
    kind("barcode"),
    kind("text"),
    kind("line"),
    kind("space"),
  ),
  kitchen: kinds(
    kind("station", { align: "center", bold: true }),
    kind("heading", { align: "center", bold: true, size: "big" }),
    kind("pickup", { align: "center", bold: true, size: "tall" }),
    kind("time_waiter"),
    kind("type_guests"),
    kind("items", { bold: true, size: "tall", addons: "groups" }),
    kind("remark", { bold: true, above: true }),
    kind("text"),
    kind("line", { ch: "=" }),
    kind("space"),
  ),
};

const ORDER: Record<PaperKind, string[]> = {
  receipt: [
    "logo", "name", "address", "phone", "brn", "vat", "header", "line",
    "title", "customer_no", "receipt_no", "date_order", "order_type", "served_by", "guests", "customer", "refund_of", "line",
    "items", "line",
    "subtotal", "discounts", "service", "taxes", "rounding", "total", "share", "payments",
    "bill_note", "remark", "footer", "barcode",
  ],
  kitchen: ["station", "heading", "pickup", "time_waiter", "type_guests", "line", "items", "remark", "line"],
};

// EasyPay's designs: the papers as they were before there was a designer.
export const EASYPAY: Record<PaperKind, Design> = {
  receipt: { blocks: ORDER.receipt.map((k) => ({ ...KINDS.receipt[k] })) },
  kitchen: { blocks: ORDER.kitchen.map((k) => ({ ...KINDS.kitchen[k] })) },
};

const ADDONS: Record<PaperKind, string[]> = { receipt: ["line", "rows"], kitchen: ["groups", "line"] };
const SIZES = ["normal", "tall", "big"];
const ALIGNS = ["left", "center", "right"];

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (o: Loose, k: string): boolean | undefined => (typeof o[k] === "boolean" ? (o[k] as boolean) : undefined);
const str = (o: Loose, k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const int = (o: Loose, k: string): number | undefined => (typeof o[k] === "number" && Number.isInteger(o[k]) ? (o[k] as number) : undefined);

// A paper read as the till reads it: EasyPay's when there is none
// (`fellBack` false) or when it cannot be read (`fellBack` true: not one, of
// another version, a locked block missing or hidden). A block of a kind not
// known is skipped, so is a second of a kind that is there once; a setting
// not understood takes the kind's own; sixty blocks at most.
export function readDesign(paper: PaperKind, raw: unknown, shop: boolean): { design: Design; fellBack: boolean } {
  const easypay = { design: EASYPAY[paper], fellBack: false };
  if (raw === undefined || raw === null) return easypay;
  const fell = { design: EASYPAY[paper], fellBack: true };
  if (!isObj(raw) || int(raw, "v") !== VERSION || !Array.isArray(raw.blocks)) return fell;
  const all = KINDS[paper];
  const seen = new Set<string>();
  const out: Block[] = [];
  for (const r of raw.blocks as unknown[]) {
    if (!isObj(r)) continue;
    const k = str(r, "k");
    if (k === undefined || !Object.prototype.hasOwnProperty.call(all, k)) continue;
    const base = all[k];
    if (!REPEATABLE.includes(k)) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    const size = str(r, "size");
    const align = str(r, "align");
    const ch = str(r, "ch");
    const n = int(r, "n");
    const addons = str(r, "addons");
    out.push({
      k,
      hide: bool(r, "hide") ?? base.hide,
      size: size !== undefined && SIZES.includes(size) ? (size as Size) : base.size,
      bold: bool(r, "bold") ?? base.bold,
      align: align !== undefined && ALIGNS.includes(align) ? (align as Align) : base.align,
      above: bool(r, "above") ?? base.above,
      text: (str(r, "text") ?? base.text).replace(/\r/g, "").slice(0, TEXT),
      ch: ch === "-" || ch === "=" ? ch : base.ch,
      n: n !== undefined && n >= 1 && n <= 5 ? n : base.n,
      addons: addons !== undefined && ADDONS[paper].includes(addons) ? addons : base.addons,
      addonPrices: bool(r, "addonPrices") ?? base.addonPrices,
      unitPrice: bool(r, "unitPrice") ?? base.unitPrice,
      notes: bool(r, "notes") ?? base.notes,
      was: bool(r, "was") ?? base.was,
      seat: bool(r, "seat") ?? base.seat,
    });
    if (out.length === MOST) break;
  }
  const locked = LOCKED[paper].concat(paper === "receipt" && shop ? ["barcode"] : []);
  if (locked.some((k) => !out.some((b) => b.k === k && !b.hide))) return fell;
  return { design: { blocks: out }, fellBack: false };
}

// A design as it is kept: each block its kind and only what differs from the kind's own.
export function compact(paper: PaperKind, d: Design): { v: number; blocks: Loose[] } {
  return {
    v: VERSION,
    blocks: d.blocks.map((b) => {
      const base = KINDS[paper][b.k] ?? BASE;
      const o: Loose = { k: b.k };
      for (const key of Object.keys(BASE) as (keyof Block)[]) if (key !== "k" && b[key] !== base[key]) o[key] = b[key];
      return o;
    }),
  };
}

// ---- the printing, as EscPos and Docs do it ----

export function wrap(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    for (const word of para.trim().split(" ").filter((x) => x.length > 0)) {
      let rest = word;
      while (rest.length > w) {
        // a word wider than the paper
        if (cur.length > 0) {
          lines.push(cur);
          cur = "";
        }
        lines.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      if (cur.length === 0) cur = rest;
      else if (cur.length + 1 + rest.length <= w) cur += " " + rest;
      else {
        lines.push(cur);
        cur = rest;
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines;
}

const group = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// "1,250.00", with as many decimals as the business set
export function num(cents: number, decimals: number): string {
  const neg = cents < 0;
  const v = Math.abs(cents);
  const body =
    decimals === 0
      ? group(Math.floor((v + 50) / 100))
      : decimals === 1
        ? `${group(Math.floor((v + 5) / 100))}.${Math.floor(((v + 5) % 100) / 10)}`
        : `${group(Math.floor(v / 100))}.${String(v % 100).padStart(2, "0")}`;
  return (neg ? "-" : "") + body;
}

// thousandths: "2", "0.5"
export function qty(q: number): string {
  if (q % 1000 === 0) return String(q / 1000);
  return `${Math.trunc(q / 1000)}.${String(Math.abs(q % 1000)).padStart(3, "0")}`.replace(/0+$/, "");
}

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Indian/Mauritius",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// "21/09/2026 18:13", in Mauritius
export function stamp(ms: number): string {
  const p = Object.fromEntries(CLOCK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// Code 128 set B, as EscPos.barcodeModule: the widest bars that fit, or none
function barsFit(code: string, columns: number): boolean {
  if (code.length === 0 || code.length > 60 || [...code].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) return false;
  const dots = columns <= 32 ? 384 : 576;
  return [3, 2, 1].some((m) => ((code.length + 3) * 11 + 2) * m <= dots);
}

type St = { size: Size; bold: boolean; align: Align };
type Out =
  | { o: "words"; s: string; indent?: string; st?: St }
  | { o: "line"; s: string; st?: St }
  | { o: "row"; left: string; right: string; st?: St; indent?: string }
  | { o: "rule"; ch: string }
  | { o: "blank" }
  | { o: "bars"; code: string }
  | { o: "picture" };

const PLAIN: St = { size: "normal", bold: false, align: "left" };

class Page {
  columns: number;
  lines: Styled[] = [];
  // where the logo goes, as the number of lines above it: it is no line of text
  logoAt: number | null = null;
  constructor(columns: number) {
    this.columns = columns;
  }
  line(t: string, st: St) {
    this.lines.push({ t: t.trimEnd(), size: st.size, bold: st.bold, align: st.align });
  }
  row(left: string, right: string, width: number, indent: string, st: St) {
    const room = Math.max(width - right.length - 1 - indent.length, 4);
    const parts = wrap(left, room);
    parts.forEach((p, i) => this.line(i === 0 ? (indent + p).padEnd(width - right.length) + right : indent + p, st));
    if (parts.length === 0) this.line(right.padStart(width), st);
  }
  print(b: Block, outs: Out[]) {
    if (outs.length === 0) return;
    if (b.above) this.line("-".repeat(this.columns), PLAIN);
    const own: St = { size: b.size, bold: b.bold, align: b.align };
    const width = (s: St) => (s.size === "big" ? Math.floor(this.columns / 2) : this.columns);
    for (const o of outs) {
      if (o.o === "words") {
        const s = o.st ?? own;
        const indent = o.indent ?? "";
        for (const l of wrap(o.s, width(s) - indent.length)) this.line(indent + l, s);
      } else if (o.o === "line") {
        const s = o.st ?? own;
        if (s.size === "big") for (const l of wrap(o.s, width(s))) this.line(l, s);
        else this.line(o.s, s);
      } else if (o.o === "row") {
        const s = { ...(o.st ?? own), align: "left" as Align };
        this.row(o.left, o.right, width(s), o.indent ?? "", s);
      } else if (o.o === "rule") this.line(o.ch.repeat(this.columns), PLAIN);
      else if (o.o === "blank") this.line("", PLAIN);
      else if (o.o === "bars") {
        if (!barsFit(o.code, this.columns)) continue;
        this.lines.push({ t: "", size: "normal", bold: false, align: "center", bars: o.code });
        this.line(o.code, { size: "normal", bold: false, align: "center" });
      }
      else if (o.o === "picture") this.logoAt = this.lines.length;
    }
  }
  done(): Styled[] {
    const l = this.lines.slice();
    while (l.length > 0 && l[l.length - 1].t.trim() === "" && l[l.length - 1].bars === undefined) l.pop();
    return l;
  }
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// {customer_no} and the rest: one with nothing to say is left empty; a word
// in braces that is not one is printed as it was typed
export function fill(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{([a-z_]+)\}/g, (m, k: string) => (has(vars, k) ? (vars[k] ?? "") : m));
}

const textOut = (b: Block, vars: Record<string, string | null | undefined>): Out[] => {
  const s = fill(b.text, vars);
  return s.trim() !== "" ? [{ o: "words", s }] : [];
};
const words = (s: string): Out[] => (s.trim() !== "" ? [{ o: "words", s }] : []);
const nb = (s: string | null | undefined): s is string => s !== null && s !== undefined && s.trim() !== "";

export const addonName = (a: DocAddon) => ((a.qty ?? 1) > 1 ? `${a.qty} x ${a.name}` : a.name);

export const RECEIPT_VARS = ["business", "customer_no", "order", "receipt_no", "date", "time", "cashier", "waiter", "guests", "order_type", "customer", "total"];
export const KITCHEN_VARS = ["customer_no", "order", "date", "time", "waiter", "guests", "order_type", "station", "pickup"];

function receiptVars(d: ReceiptDoc, shop: Shop, decimals: number) {
  const at = stamp(d.time ?? 0);
  return {
    business: shop.name,
    customer_no: d.customerNo,
    order: d.order ?? "",
    receipt_no: d.number ?? "",
    date: at.split(" ")[0],
    time: at.split(" ")[1],
    cashier: d.cashier,
    waiter: d.waiter,
    guests: d.covers === null || d.covers === undefined ? null : String(d.covers),
    order_type: d.dining,
    customer: d.customer,
    total: "Rs " + num(d.total ?? 0, decimals),
  };
}

function kitchenVars(d: KitchenDoc) {
  const at = stamp(d.time);
  return {
    customer_no: d.customerNo,
    order: d.order,
    date: at.split(" ")[0],
    time: at.split(" ")[1],
    waiter: d.waiter,
    guests: d.covers === null || d.covers === undefined ? null : String(d.covers),
    order_type: d.dining,
    station: d.station,
    pickup: d.pickup,
  };
}

function item(b: Block, l: DocLine, n: (c: number) => string): Out[] {
  const addons = l.addons ?? [];
  const priced = b.addonPrices && addons.length > 0;
  const adds = priced ? addons.reduce((s, a) => s + (a.price ?? 0), 0) : 0;
  const out: Out[] = [{ o: "row", left: `${qty(l.qty)} ${l.name}`, right: n(l.amount - adds) }];
  if (b.unitPrice && l.unit !== null && l.unit !== undefined && l.qty !== 1000) out.push({ o: "words", s: `${qty(l.qty)} x ${n(l.unit)}`, indent: "  ", st: PLAIN });
  if (b.was && l.was !== null && l.was !== undefined && l.was !== l.amount)
    out.push({ o: "words", s: [`was ${n(l.was - adds)}`, ...(nb(l.priceNote) ? [l.priceNote] : [])].join(", "), indent: "  ", st: PLAIN });
  if (priced) {
    if (b.addons === "rows")
      for (const a of addons)
        out.push((a.price ?? 0) !== 0 ? { o: "row", left: `+ ${addonName(a)}`, right: n(a.price ?? 0), st: PLAIN, indent: "  " } : { o: "words", s: `+ ${addonName(a)}`, indent: "  ", st: PLAIN });
    else out.push({ o: "words", s: "+ " + addons.map((a) => addonName(a) + ((a.price ?? 0) !== 0 ? ` ${n(a.price ?? 0)}` : "")).join(", "), indent: "  ", st: PLAIN });
  } else {
    const mods = l.mods ?? [];
    const names = mods.length > 0 ? mods : addons.map(addonName);
    if (names.length > 0) {
      if (b.addons === "rows") for (const m of names) out.push({ o: "words", s: `+ ${m}`, indent: "  ", st: PLAIN });
      else out.push({ o: "words", s: "+ " + names.join(", "), indent: "  ", st: PLAIN });
    }
  }
  if (b.notes && nb(l.note)) out.push({ o: "words", s: `* ${l.note}`, indent: "  ", st: PLAIN });
  return out;
}

function receiptOut(b: Block, d: ReceiptDoc, shop: Shop, decimals: number, logo: boolean): Out[] {
  const n = (c: number) => num(c, decimals);
  const kind = d.kind ?? "receipt";
  const number = d.number ?? "";
  const total = d.total ?? 0;
  const payments = d.payments ?? [];
  const taxes = d.taxes ?? [];
  const discounts = d.discounts ?? [];
  const rounding = d.rounding ?? 0;
  const service = d.service ?? 0;
  switch (b.k) {
    case "logo":
      return logo ? [{ o: "picture" }] : [];
    case "name":
      return words(shop.name);
    case "address":
      return words(shop.address);
    case "phone":
      return nb(shop.phone) ? [{ o: "line", s: `Tel: ${shop.phone}` }] : [];
    case "brn":
      return nb(shop.brn) ? [{ o: "line", s: `BRN: ${shop.brn}` }] : [];
    case "vat":
      return nb(shop.vat) ? [{ o: "line", s: `VAT: ${shop.vat}` }] : [];
    case "header":
      return words(shop.header);
    case "title": {
      const out: Out[] = [{ o: "line", s: kind === "bill" ? "BILL" : kind === "refund" ? "REFUND" : "RECEIPT" }];
      if (d.reprint) out.push({ o: "line", s: "COPY" });
      if ((d.refunded ?? 0) > 0) out.push({ o: "line", s: d.refundedAll ? "*** REFUNDED ***" : `*** PARTLY REFUNDED: ${n(d.refunded ?? 0)} ***` });
      return out;
    }
    case "customer_no":
      return d.customerNo !== null && d.customerNo !== undefined ? [{ o: "words", s: `CUSTOMER No. ${d.customerNo}` }] : [];
    case "receipt_no":
      return nb(number) ? [{ o: "row", left: "No.", right: number }] : [];
    case "date_order":
      return [{ o: "row", left: stamp(d.time ?? 0), right: d.order ?? "" }];
    case "order_type":
      return d.dining !== null && d.dining !== undefined ? [{ o: "row", left: "Order type", right: d.dining }] : [];
    case "served_by": {
      const out: Out[] = [];
      const by = d.cashier ?? d.waiter;
      if (by !== null && by !== undefined) out.push({ o: "row", left: "Served by", right: by });
      if (d.waiter !== null && d.waiter !== undefined && d.cashier !== null && d.cashier !== undefined && d.waiter !== d.cashier) out.push({ o: "row", left: "Waiter", right: d.waiter });
      return out;
    }
    case "guests":
      return d.covers !== null && d.covers !== undefined ? [{ o: "row", left: "Guests", right: String(d.covers) }] : [];
    case "customer":
      return nb(d.customer) && d.customer !== d.order ? [{ o: "row", left: "Customer", right: d.customer }] : [];
    case "refund_of": {
      const out: Out[] = [];
      if (d.refundOf !== null && d.refundOf !== undefined) out.push({ o: "row", left: "Refund of", right: d.refundOf });
      if (nb(d.reason)) out.push({ o: "words", s: `Reason: ${d.reason}` });
      return out;
    }
    case "items":
      return (d.lines ?? []).flatMap((l) => item(b, l, n));
    case "subtotal":
      return discounts.length > 0 || rounding !== 0 || service !== 0 ? [{ o: "row", left: "Subtotal", right: n(d.subtotal ?? 0) }] : [];
    case "discounts":
      return discounts.map((x) => ({ o: "row", left: `Discount: ${x.name}`, right: "-" + n(x.amount) }));
    case "service":
      return service !== 0 ? [{ o: "row", left: "Service charge", right: n(service) }] : [];
    case "taxes":
      return taxes.map((t) => {
        const rate = t.rateBp % 100 === 0 ? String(t.rateBp / 100) : (t.rateBp / 100).toFixed(2);
        return { o: "row", left: `${t.name} ${rate}%` + (t.included ? " (incl.)" : ""), right: n(t.amount) };
      });
    case "rounding":
      return rounding !== 0 ? [{ o: "row", left: "Rounding", right: n(rounding) }] : [];
    case "total":
      return [{ o: "row", left: kind === "refund" ? "REFUNDED" : "TOTAL", right: "Rs " + n(total) }];
    case "share": {
      if (d.share === null || d.share === undefined || d.shares === null || d.shares === undefined) return [];
      const mine = payments.reduce((s, p) => s + p.amount, 0);
      const tax = taxes.reduce((s, t) => s + t.amount, 0);
      const out: Out[] = [{ o: "row", left: `SHARE ${d.share} OF ${d.shares}`, right: "Rs " + n(mine) }];
      if (tax > 0 && total > 0) out.push({ o: "row", left: "Tax in this share", right: n(Math.floor((tax * mine + Math.floor(total / 2)) / total)), st: PLAIN });
      return out;
    }
    case "payments":
      return payments.flatMap((p) => {
        const out: Out[] = [{ o: "row", left: p.name, right: n(p.amount) }];
        if (nb(p.reference)) out.push({ o: "line", s: `  Ref: ${p.reference}` });
        if (p.tendered !== null && p.tendered !== undefined && (p.change ?? 0) > 0)
          out.push({ o: "row", left: "  Given", right: n(p.tendered) }, { o: "row", left: "  Change", right: n(p.change ?? 0) });
        return out;
      });
    case "bill_note":
      return kind === "bill" ? [{ o: "words", s: "This is not a receipt" }] : [];
    case "remark":
      return nb(d.note) ? [{ o: "words", s: `Remark: ${d.note}` }] : [];
    case "footer":
      return words(shop.footer);
    case "barcode":
      return shop.bars && kind !== "bill" && nb(number) ? [{ o: "blank" }, { o: "bars", code: number }] : [];
    case "text":
      return textOut(b, receiptVars(d, shop, decimals));
    case "line":
      return [{ o: "rule", ch: b.ch }];
    case "space":
      return Array.from({ length: b.n }, () => ({ o: "blank" }) as Out);
    default:
      return [];
  }
}

function kitchenOut(b: Block, d: KitchenDoc): Out[] {
  switch (b.k) {
    case "station":
      return [{ o: "line", s: d.title === "ORDER" ? d.station.toUpperCase() : `${d.title} - ${d.station.toUpperCase()}` }];
    case "heading":
      if (d.customerNo !== null && d.customerNo !== undefined) {
        const out: Out[] = [{ o: "line", s: `No. ${d.customerNo}` }];
        if (nb(d.order)) out.push({ o: "words", s: d.order, st: { size: "normal", bold: b.bold, align: b.align } });
        return out;
      }
      return words(d.order);
    case "pickup":
      return d.pickup !== null && d.pickup !== undefined ? [{ o: "line", s: d.pickup }] : [];
    case "time_waiter":
      return [{ o: "row", left: stamp(d.time), right: d.waiter ?? "" }];
    case "type_guests": {
      const extra = [d.dining, d.covers !== null && d.covers !== undefined ? `${d.covers} guests` : null].filter((x): x is string => x !== null && x !== undefined).join(" · ");
      return extra.trim() !== "" ? [{ o: "line", s: extra.replaceAll("·", "-") }] : [];
    }
    case "items": {
      let course: number | null = null;
      const courses = d.lines.some((l) => (l.course ?? 1) > 1);
      return d.lines.flatMap((l) => {
        const out: Out[] = [];
        if (courses && l.course !== null && l.course !== undefined && l.course !== course) {
          course = l.course;
          out.push({ o: "line", s: `--- Course ${l.course} ---`, st: { size: "normal", bold: false, align: "center" } });
        }
        out.push({ o: "words", s: `${qty(l.qty)} x ${l.name}` });
        if (b.seat && l.seat !== null && l.seat !== undefined) out.push({ o: "line", s: `   Seat ${l.seat}`, st: PLAIN });
        const mods = l.mods ?? [];
        if (b.addons === "line") {
          if (mods.length > 0) out.push({ o: "words", s: "* " + mods.join(", "), indent: "   ", st: PLAIN });
        } else for (const m of mods) out.push({ o: "words", s: `* ${m}`, indent: "   ", st: PLAIN });
        if (b.notes && nb(l.note)) out.push({ o: "words", s: `! ${l.note}`, indent: "   ", st: { size: "normal", bold: true, align: "left" } });
        return out;
      });
    }
    case "remark":
      return nb(d.note) ? [{ o: "words", s: `REMARK: ${d.note}` }] : [];
    case "text":
      return textOut(b, kitchenVars(d));
    case "line":
      return [{ o: "rule", ch: b.ch }];
    case "space":
      return Array.from({ length: b.n }, () => ({ o: "blank" }) as Out);
    default:
      return [];
  }
}

// The receipt (a bill, a refund, a share) as the till prints it. `logo`: the
// logo block has a picture to show (the preview draws it above the lines).
export function renderReceipt(design: Design, d: ReceiptDoc, shop: Shop, columns: number, decimals: number, logo = false): Styled[] {
  return previewReceipt(design, d, shop, columns, decimals, logo).lines;
}

// The same, and where the logo is drawn among the lines (null: nowhere).
export function previewReceipt(design: Design, d: ReceiptDoc, shop: Shop, columns: number, decimals: number, logo: boolean): { lines: Styled[]; logoAt: number | null } {
  const p = new Page(columns);
  for (const b of design.blocks) if (!b.hide) p.print(b, receiptOut(b, d, shop, decimals, logo));
  return { lines: p.done(), logoAt: p.logoAt };
}

export function renderKitchen(design: Design, d: KitchenDoc, columns: number): Styled[] {
  const p = new Page(columns);
  for (const b of design.blocks) if (!b.hide) p.print(b, kitchenOut(b, d));
  return p.done();
}

// ---- the preview's made-up order ----

const SAMPLE_LINES: DocLine[] = [
  { qty: 2000, name: "Dholl puri", amount: 10000, mods: ["Achard, Chutney coco"], addons: [{ name: "Achard" }, { name: "Chutney coco" }], unit: 5000 },
  {
    qty: 1000,
    name: "Burger",
    amount: 30000,
    mods: ["Cheese, Bacon"],
    addons: [
      { name: "Cheese", price: 2000 },
      { name: "Bacon", price: 3000 },
    ],
    unit: 25000,
    note: "Well done",
  },
  { qty: 2000, name: "Alouda", amount: 18000, unit: 9000 },
];

// A receipt or a bill for a takeaway (customer No. 05) or a table; a shop's sale.
export function sampleReceipt(kind: "receipt" | "bill", takeaway: boolean, shop: boolean, now: number): ReceiptDoc {
  const total = 58000;
  return {
    kind,
    number: kind === "bill" ? "" : "S1-T1-000128",
    time: now,
    order: shop ? "C-01" : takeaway ? "A-05 · Ravi" : "Table 4",
    dining: shop ? null : takeaway ? "Takeaway" : "Dine-in",
    cashier: "Priya",
    covers: takeaway || shop ? null : 2,
    note: takeaway && !shop ? "Ring at the gate" : null,
    lines: SAMPLE_LINES,
    subtotal: total,
    taxes: [{ name: "VAT", rateBp: 1500, amount: 7565, included: true }],
    total,
    payments: kind === "bill" ? [] : [{ name: "Cash", amount: total, tendered: 60000, change: 2000 }],
    customerNo: takeaway && !shop ? "05" : null,
  };
}

export function sampleKitchen(takeaway: boolean, now: number): KitchenDoc {
  return {
    title: "ORDER",
    order: takeaway ? "Ravi" : "Table 4",
    time: now,
    waiter: "Priya",
    dining: takeaway ? "Takeaway" : "Dine-in",
    covers: takeaway ? null : 2,
    note: takeaway ? "Tel 5 123 4567" : null,
    lines: [
      { qty: 2000, name: "Dholl puri", amount: 0, mods: ["Achard, Chutney coco"] },
      { qty: 1000, name: "Burger", amount: 0, mods: ["Cheese, Bacon", "Well done"], seat: takeaway ? null : 2, note: "No onion" },
    ],
    station: "Kitchen",
    pickup: takeaway ? "PICK UP 18:30" : null,
    customerNo: takeaway ? "05" : null,
  };
}
