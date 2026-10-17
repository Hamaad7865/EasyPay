// The sales journal: Carfectionist's (Cashmag's "Journal de ventes") in
// EasyPay. ONE period, aggregated once, broken down down the page: sale
// methods, taxes, payments, categories, users.
//
// CASH-RECEIVED BASIS, as Carfectionist's: every figure is money that reached
// the business inside the period, whatever sale it paid for. A sale paid at
// the counter is takings that day. A sale put on a customer's account (0114)
// is takings only when, and as far as, money is paid on it: the day it is
// paid, whenever it was sold. What a credit note, returned goods or a deposit
// paid on a sale was not money taken that day, so it is not takings either.
// Money given back on a return is negative takings, the day it is given.
//
// The invariant that makes it right: every section foots to the SAME pair of
// totals, the money received in the period (incl. and excl. VAT). VAT and
// categories come from the sales' lines, but money arrives per payment, so
// each sale's own figures (its total, the VAT on its receipt) are scaled to
// the share of it that was paid inside the period, then split over its lines
// with allocate() (largest remainder): no cent is invented or lost.
//
// The bridge to what was SOLD (the Sales summary's total), shown under the
// payments, holds to the cent:
//   sold = money received - money on earlier sales + settled without money + on account
//
// Pure: no database here (journal-db.ts fetches), so the money maths is tested
// with fixtures (journal.test.mjs). Money is cents, quantities thousandths.

export type Doc = {
  id: string;
  number: string;
  type: "sale" | "refund";
  total: number; // positive for a refund too: its money carries the sign
  tax: number; // the VAT on the receipt: added and included
  day: string; // the store's day of the sale, yyyy-mm-dd
  minute: number; // its time of day, in minutes, on the store's clock
  device: string | null; // the till's name
  employee: string | null; // who rang it up
  customer: string | null; // the customer's id
  method: string | null; // a restaurant's order type; a shop: null
  inPeriod: boolean; // sold in the period (false: an earlier sale paid on now)
};

export type Line = {
  doc: string;
  name: string;
  category: string | null;
  qty: number; // thousandths
  excl: number; // the line's share of the sale before VAT: weights only
  tax: number; // its VAT: a weight only
  rate: string; // the tax it carries, as named: "VAT 15%", "No tax"
};

// Money received: at the counter (a receipt's own payment, a refund's money
// back negative) or paid later on an account (one line of a payment).
export type Money = { doc: string; method: string; amount: number; by: string | null; account: boolean };

// What paid a sale without money in the period: returned goods, a credit
// note, a deposit, or the part put on account; a refund's the same, negative.
// bill: a refund's part taken off an account names the sale it came off.
export type Without = { doc: string; kind: "exchange" | "credit_note" | "deposit" | "account"; amount: number; bill?: string | null };

export type Filters = { device?: string; user?: string; item?: string; from?: number; to?: number };

export type Input = {
  from: string;
  to: string;
  docs: Doc[];
  lines: Line[];
  money: Money[];
  without: Without[];
  customers: Map<string, string>;
  filters?: Filters;
  shopLabel?: string; // a shop's one sale method
};

export type Ref = { id: string; number: string; customer: string | null; cents: number; day: string; earlier: boolean };
export type Row = { label: string; n: number; excl: number; incl: number };
export type TaxRow = { label: string; tax: number; excl: number; incl: number };
export type CatRow = { label: string; qty: number; pct: number; excl: number; incl: number };
export type PayRow = { label: string; n: number; cents: number; refs: Ref[] };

export type Journal = {
  from: string;
  to: string;
  bills: number; // sales that took money in the period
  incl: number; // THE headline: money received, VAT in
  excl: number;
  vat: number;
  avg: number;
  clients: number;
  clientIncl: number;
  clientAvg: number;
  methods: Row[];
  taxes: TaxRow[];
  payments: PayRow[];
  received: number; // = incl
  earlier: number; // of which money on sales made before the period
  earlierRefs: Ref[];
  without: number; // settled without money in the period
  withoutRefs: Ref[];
  onAccount: number; // sold in the period, still on account at its end
  onAccountRefs: Ref[];
  sold: number; // what the period sold, less its refunds
  categories: CatRow[];
  users: Row[];
};

// Split `total` across `weights` so the parts are proportional AND add up to
// exactly `total`: largest remainder, so no cent is invented or lost. All-zero
// weights: an even split, the remainder to the front.
export function allocate(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    const base = Math.trunc(total / n);
    const out = new Array<number>(n).fill(base);
    let rest = total - base * n;
    for (let i = 0; rest !== 0; i = (i + 1) % n) {
      const step = rest > 0 ? 1 : -1;
      out[i] += step;
      rest -= step;
    }
    return out;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const floor = exact.map((x) => Math.trunc(x));
  let rest = total - floor.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: Math.abs(x - Math.trunc(x)) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = rest >= 0 ? 1 : -1;
  for (let k = 0; rest !== 0 && k < order.length * 4; k++) {
    floor[order[k % order.length].i] += step;
    rest -= step;
  }
  return floor;
}

export const UNCATEGORISED = "No category";
export const NOBODY = "Not recorded";

export function buildJournal(input: Input): Journal {
  const f = input.filters ?? {};
  const docById = new Map(input.docs.map((d) => [d.id, d]));
  const linesOf = new Map<string, Line[]>();
  for (const l of input.lines) {
    const a = linesOf.get(l.doc);
    if (a) a.push(l);
    else linesOf.set(l.doc, [l]);
  }

  // 1. The filters, on whole sales: a line-level filter would leave Categories
  // disagreeing with the rest. An earlier sale is held to the same filters; with
  // an item asked for, its money is left out rather than guessed at, as
  // Carfectionist does.
  const passes = (d: Doc): boolean => {
    if (f.device && (d.device ?? "") !== f.device) return false;
    if (f.user && (d.employee ?? NOBODY) !== f.user) return false;
    if (f.item) {
      if (!d.inPeriod) return false;
      if (!(linesOf.get(d.id) ?? []).some((l) => l.name === f.item)) return false;
    }
    if (f.from !== undefined && d.minute < f.from) return false;
    if (f.to !== undefined && d.minute > f.to) return false;
    return true;
  };
  const keep = new Set(input.docs.filter(passes).map((d) => d.id));

  const ref = (d: Doc, cents: number): Ref => ({
    id: d.id, number: d.number, customer: d.customer ? (input.customers.get(d.customer) ?? null) : null, cents, day: d.day, earlier: !d.inPeriod,
  });
  const roll = (into: Map<string, Ref>, r: Ref) => {
    const seen = into.get(r.id);
    if (seen) seen.cents += r.cents;
    else into.set(r.id, { ...r });
  };
  const listOf = (m: Map<string, Ref>) => [...m.values()].filter((r) => r.cents !== 0).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : Math.abs(b.cents) - Math.abs(a.cents)));

  // 2. The money: every payment that counts, once.
  const pay = new Map<string, { label: string; n: number; cents: number; refs: Map<string, Ref> }>();
  const earlier = new Map<string, Ref>();
  const counted = new Map<string, { cents: number; by: string }[]>();
  for (const m of input.money) {
    const d = docById.get(m.doc);
    if (!d || !keep.has(d.id) || m.amount === 0) continue;
    const row = pay.get(m.method) ?? { label: m.method, n: 0, cents: 0, refs: new Map<string, Ref>() };
    row.n += 1;
    row.cents += m.amount;
    roll(row.refs, ref(d, m.amount));
    pay.set(m.method, row);
    if (!d.inPeriod) roll(earlier, ref(d, m.amount));
    const list = counted.get(d.id) ?? [];
    list.push({ cents: m.amount, by: m.by ?? NOBODY });
    counted.set(d.id, list);
  }

  // 3. Each sale scaled to the share of it the period's money paid, then split
  // over its lines: three splits (excl, VAT) each footing to the sale's paid
  // figure, so every column foots and every row keeps incl = excl + VAT.
  let incl = 0, excl = 0, clientIncl = 0;
  const bills = new Set<string>();
  const clients = new Set<string>();
  const methods = new Map<string, Row>();
  const users = new Map<string, Row>();
  const userBills = new Map<string, Set<string>>();
  const methodBills = new Map<string, Set<string>>();
  const taxes = new Map<string, TaxRow>();
  const cats = new Map<string, CatRow>();
  for (const [id, list] of counted) {
    const d = docById.get(id)!;
    const paid = list.reduce((a, c) => a + c.cents, 0);
    if (paid === 0) continue;
    // a sale that came to nothing cannot be scaled: its money (there should be none) goes under no tax
    const share = d.total === 0 ? 0 : paid / d.total;
    const docExcl = d.total - d.tax;
    const paidExcl = d.total === 0 ? paid : Math.round(docExcl * share);
    const paidVat = paid - paidExcl;
    incl += paid;
    excl += paidExcl;
    if (d.type === "sale" && list.some((c) => c.cents > 0)) bills.add(id);
    if (d.customer) {
      clients.add(d.customer);
      clientIncl += paid;
    }
    const mLabel = d.method ?? input.shopLabel ?? "Sales";
    const mr = methods.get(mLabel) ?? { label: mLabel, n: 0, excl: 0, incl: 0 };
    mr.excl += paidExcl;
    mr.incl += paid;
    methods.set(mLabel, mr);
    if (d.type === "sale" && paid > 0) {
      const s = methodBills.get(mLabel) ?? new Set<string>();
      s.add(id);
      methodBills.set(mLabel, s);
    }
    // who took the money: each payment's part of the sale's excl, pro rata
    const exclBy = allocate(paidExcl, list.map((c) => c.cents));
    list.forEach((c, i) => {
      const u = users.get(c.by) ?? { label: c.by, n: 0, excl: 0, incl: 0 };
      u.incl += c.cents;
      u.excl += exclBy[i];
      users.set(c.by, u);
      if (c.cents > 0 && d.type === "sale") {
        const s = userBills.get(c.by) ?? new Set<string>();
        s.add(id);
        userBills.set(c.by, s);
      }
    });
    const own = linesOf.get(id) ?? [];
    if (own.length === 0 || d.total === 0) {
      // a sale whose lines this tablet never sent: its money is still takings, under no tax and no category
      const t = taxes.get("No tax known") ?? { label: "No tax known", tax: 0, excl: 0, incl: 0 };
      t.tax += paidVat; t.excl += paidExcl; t.incl += paid;
      taxes.set("No tax known", t);
      const c = cats.get(UNCATEGORISED) ?? { label: UNCATEGORISED, qty: 0, pct: 0, excl: 0, incl: 0 };
      c.excl += paidExcl; c.incl += paid;
      cats.set(UNCATEGORISED, c);
      continue;
    }
    const lineExcl = allocate(paidExcl, allocate(docExcl, own.map((l) => l.excl)));
    const lineVat = allocate(paidVat, allocate(d.tax, own.map((l) => l.tax)));
    own.forEach((l, i) => {
      const t = taxes.get(l.rate) ?? { label: l.rate, tax: 0, excl: 0, incl: 0 };
      t.tax += lineVat[i];
      t.excl += lineExcl[i];
      t.incl += lineExcl[i] + lineVat[i];
      taxes.set(l.rate, t);
      const key = l.category ?? UNCATEGORISED;
      const c = cats.get(key) ?? { label: key, qty: 0, pct: 0, excl: 0, incl: 0 };
      c.qty += share * l.qty;
      c.excl += lineExcl[i];
      c.incl += lineExcl[i] + lineVat[i];
      cats.set(key, c);
    });
  }
  for (const [k, r] of methods) r.n = methodBills.get(k)?.size ?? 0;
  for (const [k, r] of users) r.n = userBills.get(k)?.size ?? 0;

  // 4. The bridge to what was sold. Only the period's own sales and refunds
  // (those the filters keep) were sold in it.
  const sign = (d: Doc) => (d.type === "refund" ? -1 : 1);
  let sold = 0;
  const paidOn = new Map<string, number>(); // money in the period on each of the period's sales
  for (const [id, list] of counted) if (docById.get(id)!.inPeriod) paidOn.set(id, list.reduce((a, c) => a + c.cents, 0));
  const withoutRefs = new Map<string, Ref>();
  const onAcc = new Map<string, Ref>();
  // what returns in the period took off the bills of the period's own sales
  const offOwn = new Map<string, number>();
  for (const w of input.without) {
    const d = docById.get(w.doc);
    if (!d || !keep.has(d.id) || !d.inPeriod || w.amount === 0) continue;
    if (w.kind === "account" && d.type === "sale") continue; // the on-account part: below
    if (w.kind === "account" && d.type === "refund" && w.bill) {
      const bill = docById.get(w.bill);
      if (bill && bill.inPeriod && keep.has(bill.id)) {
        offOwn.set(bill.id, (offOwn.get(bill.id) ?? 0) + w.amount);
        continue;
      }
    }
    roll(withoutRefs, ref(d, sign(d) * w.amount));
  }
  const acctOf = new Map<string, number>(); // the part of each sale put on account
  for (const w of input.without) if (w.kind === "account") acctOf.set(w.doc, (acctOf.get(w.doc) ?? 0) + w.amount);
  const paidLaterOf = new Map<string, number>(); // what was paid on it in the period, on the account
  for (const m of input.money) if (m.account) paidLaterOf.set(m.doc, (paidLaterOf.get(m.doc) ?? 0) + m.amount);
  for (const d of input.docs) {
    if (!d.inPeriod || !keep.has(d.id)) continue;
    sold += sign(d) * d.total;
    if (d.type !== "sale") continue;
    const acct = acctOf.get(d.id) ?? 0;
    if (acct === 0) continue;
    // still owed at the end of the period: the account part, less what was paid on it and returned off it in the period
    const owed = acct - (paidLaterOf.get(d.id) ?? 0) - (offOwn.get(d.id) ?? 0);
    if (owed !== 0) onAcc.set(d.id, ref(d, owed));
  }
  const earlierRefs = listOf(earlier);
  const withoutList = listOf(withoutRefs);
  const onAccountRefs = listOf(onAcc);
  const categories = [...cats.values()].sort((a, b) => b.excl - a.excl || a.label.localeCompare(b.label));
  for (const c of categories) c.pct = excl !== 0 ? (c.excl / excl) * 100 : 0;
  return {
    from: input.from,
    to: input.to,
    bills: bills.size,
    incl,
    excl,
    vat: incl - excl,
    avg: bills.size ? Math.round(incl / bills.size) : 0,
    clients: clients.size,
    clientIncl,
    clientAvg: clients.size ? Math.round(clientIncl / clients.size) : 0,
    methods: [...methods.values()].sort((a, b) => b.incl - a.incl || a.label.localeCompare(b.label)),
    taxes: [...taxes.values()].sort((a, b) => a.label.localeCompare(b.label)),
    payments: [...pay.values()].map((p) => ({ label: p.label, n: p.n, cents: p.cents, refs: listOf(p.refs) })).sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label)),
    received: incl,
    earlier: earlierRefs.reduce((a, r) => a + r.cents, 0),
    earlierRefs,
    without: withoutList.reduce((a, r) => a + r.cents, 0),
    withoutRefs: withoutList,
    onAccount: onAccountRefs.reduce((a, r) => a + r.cents, 0),
    onAccountRefs,
    sold,
    categories,
    users: [...users.values()].sort((a, b) => b.incl - a.incl || a.label.localeCompare(b.label)),
  };
}

// ---- the period: presets and comparisons, on yyyy-mm-dd, no Date with a timezone ----

export type Range = { from: string; to: string };
export type Compare = "none" | "previous-period" | "previous-month" | "previous-year";
export const COMPARISONS: { key: Compare; label: string }[] = [
  { key: "none", label: "Do not compare" },
  { key: "previous-period", label: "Previous period" },
  { key: "previous-month", label: "Previous month" },
  { key: "previous-year", label: "Previous year" },
];

const parts = (day: string): [number, number, number] => [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const asNum = (day: string) => {
  const [y, m, d] = parts(day);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const fromNum = (n: number) => {
  const d = new Date(n * 86400000);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};
export const addDays = (day: string, n: number) => fromNum(asNum(day) + n);
export const spanDays = (r: Range) => asNum(r.to) - asNum(r.from) + 1;

// A day of another month, on the same day of it as far as that month has one.
function shiftMonths(day: string, by: number): string {
  const [y, m, d] = parts(day);
  const t = y * 12 + (m - 1) + by;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function presets(today: string): { key: string; label: string; range: Range }[] {
  const [y, m] = parts(today);
  const first = iso(y, m, 1);
  const prevFirst = shiftMonths(first, -1);
  const [py, pm] = parts(prevFirst);
  return [
    { key: "today", label: "Today", range: { from: today, to: today } },
    { key: "yesterday", label: "Yesterday", range: { from: addDays(today, -1), to: addDays(today, -1) } },
    { key: "current-month", label: "Current month", range: { from: first, to: today } },
    { key: "previous-month", label: "Previous month", range: { from: prevFirst, to: iso(py, pm, daysInMonth(py, pm)) } },
  ];
}

// The period a comparison is made with: as long as this one, just before it;
// or the same days a month or a year earlier (a whole month for a whole month).
export function compareRange(c: Compare, r: Range): Range | null {
  if (c === "none") return null;
  if (c === "previous-period") {
    const n = spanDays(r);
    return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
  }
  const by = c === "previous-month" ? -1 : -12;
  const [fy, fm, fd] = parts(r.from);
  const [ty, tm, td] = parts(r.to);
  const wholeMonth = fd === 1 && fy === ty && fm === tm && td === daysInMonth(ty, tm);
  const from = shiftMonths(r.from, by);
  if (wholeMonth) {
    const [ny, nm] = parts(from);
    return { from, to: iso(ny, nm, daysInMonth(ny, nm)) };
  }
  return { from, to: shiftMonths(r.to, by) };
}

export const pctChange = (now: number, prev: number): number | null => (prev === 0 ? (now === 0 ? 0 : null) : ((now - prev) / Math.abs(prev)) * 100);
