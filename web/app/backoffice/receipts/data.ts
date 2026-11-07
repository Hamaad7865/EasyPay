import type { PoolClient } from "pg";
import type { PosSettings } from "@/lib/settings";
import type { Branch } from "@/lib/branch";
import { previewReceipt, readDesign, type Styled } from "@/lib/papers";
import { receiptDoc, shopOf, paperText, type Disc, type Head, type Line, type Pay } from "@/lib/receipt-doc";

// What the Receipts page reads (docs/superpowers/specs/2026-11-07-receipts-popup-design.md):
// the receipts of the days picked, or of every day when it looks for one number
// or for the ones still to check; and one receipt in full for its pop-up.

export const LIMIT = 500;

// the payment types a payment may be corrected to, and from: money that came in
// by hand. On account, an exchange, a credit note and a deposit each stand for
// money that moved somewhere else, and are left as they were.
export const PLAIN = ["cash", "card", "wallet", "qr", "other"];

// still open: flagged with no reason recorded yet, or with a reason not signed
// off (as the menu's badge and the dashboard count them, counts/route.ts)
const OPEN = `r.needs_review
  and (not exists (select 1 from receipt_reviews v where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)
    or exists (select 1 from receipt_reviews v where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null and v.resolved_at is null))`;

export type Row = {
  id: string; number: string; type: string; at: string; total: string; tax_total: string; counts: boolean; open: boolean;
  order_label: string | null; till: string | null; cashier: string | null; store_name: string | null;
  payments: { name: string | null; kind: string | null; ref: string | null; corrected: boolean }[];
  // why a receipt still to check was flagged (only for those)
  reviews: Review[];
};
export type Totals = { n: number; excl: number; incl: number };

// view: "days" the days picked (and the branch); "check" every receipt still to
// check; "find" every receipt whose number has q in it, on any day.
export async function receiptList(c: PoolClient, tenantId: string, a: { view: "days" | "check" | "find"; from: string; to: string; store: string | null; q: string }) {
  const [where, args] =
    a.view === "check"
      ? [OPEN, [tenantId]]
      : a.view === "find"
        ? [`r.number ilike '%' || $2 || '%'`, [tenantId, a.q.replace(/[\\%_]/g, (m) => "\\" + m)]]
        : [
            `(coalesce(r.device_time, r.created_at) at time zone s.timezone)::date between $2::date and $3::date and ($4::uuid is null or r.store_id = $4::uuid)`,
            [tenantId, a.from, a.to, a.store],
          ];
  const from = `from receipt_revenue v
    join receipts r on r.tenant_id = v.tenant_id and r.id = v.id
    join stores s on s.tenant_id = r.tenant_id and s.id = r.store_id
    left join tickets t on t.tenant_id = r.tenant_id and t.id = r.ticket_id
    left join tables tb on tb.tenant_id = r.tenant_id and tb.id = t.table_id
    left join customers cu on cu.tenant_id = r.tenant_id and cu.id = coalesce(r.customer_id, t.customer_id)
   where v.tenant_id = $1 and ${where}`;
  // the figures count what the reports count: a sale or a refund, not a second payment of one (receipt_revenue)
  const [rows, sums, open] = await Promise.all([
    c.query(
      `select r.id, r.number, r.type, coalesce(r.device_time, r.created_at) as at, r.total, r.tax_total, v.counts_as_sale as counts,
              (${OPEN}) as open, s.name as store_name,
              (select d.name from pos_devices d where d.tenant_id = r.tenant_id and d.id = r.device_id) as till,
              (select e.name from employees e where e.tenant_id = r.tenant_id and e.id = r.employee_id) as cashier,
              coalesce(case when tb.name ~ '^[0-9]' then 'Table ' || tb.name else tb.name end,
                       nullif(concat_ws(' · ', t.order_no, coalesce(t.name, cu.name)), '')) as order_label,
              coalesce((select jsonb_agg(jsonb_build_object('name', pt.name, 'kind', pt.kind, 'ref', p.reference,
                                'corrected', p.payment_type_id <> p.original_payment_type_id) order by p.amount desc)
                 from receipt_payments_effective p
                 left join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id
                where p.tenant_id = r.tenant_id and p.receipt_id = r.id), '[]'::jsonb) as payments,
              case when ${OPEN} then coalesce((select jsonb_agg(jsonb_build_object('reason', w.reason, 'detail', w.detail,
                                'resolved_at', w.resolved_at, 'resolution', w.resolution) order by w.reason)
                 from receipt_reviews w where w.tenant_id = r.tenant_id and w.receipt_id = r.id and w.deleted_at is null), '[]'::jsonb)
                   else '[]'::jsonb end as reviews
         ${from}
        order by coalesce(r.device_time, r.created_at) desc, r.number desc limit ${LIMIT + 1}`,
      args,
    ),
    c.query(
      `select count(*)::int as n,
              coalesce(sum(v.signed_total) filter (where v.counts_as_sale), 0)::bigint as incl,
              coalesce(sum(case when r.type = 'refund' then -(r.total - r.tax_total) else r.total - r.tax_total end) filter (where v.counts_as_sale), 0)::bigint as excl
         ${from}`,
      args,
    ),
    // every receipt still to check, whatever is picked: the warning is the badge's number
    c.query(`select count(*)::int as n from receipts r where r.deleted_at is null and r.tenant_id = $1 and ${OPEN}`, [tenantId]),
  ]);
  const s = sums.rows[0] as { n: number; incl: string; excl: string };
  return {
    rows: rows.rows as Row[],
    totals: { n: s.n, incl: Number(s.incl), excl: Number(s.excl) } as Totals,
    open: (open.rows[0] as { n: number }).n,
  };
}

export type Review = { reason: string; detail: Record<string, unknown>; resolved_at: string | null; resolution: string | null };
export type PayRow = { type: string; name: string | null; kind: string | null; amount: number; was: string | null; reference: string | null };
export type Opened = {
  id: string; number: string; type: string; at: string; store_name: string | null; till: string | null; needs_review: boolean;
  total: number; tax_total: number;
  customer: { id: string; name: string; phone: string | null; email: string | null } | null;
  refund_of: { id: string; number: string } | null;
  pays: PayRow[]; reviews: Review[];
  paper: { lines: Styled[]; logoAt: number | null; logo: string | null; logoAlign: "left" | "center" | "right" };
  text: string;
};

export const COLUMNS = 48;
// the text sent or copied is laid out as a 58 mm paper's, so a phone's WhatsApp shows it without wrapping
export const TEXT_COLUMNS = 32;

// One receipt in full: its rows, and its paper as the till prints a copy of it.
export async function openReceipt(
  c: PoolClient, tenantId: string, id: string, s: PosSettings, stores: Branch[], retail: boolean,
): Promise<Opened | null> {
  const [hq, lq, mq, tq, dq, pq, vq, aq] = await Promise.all([
    c.query(
      `select r.id, r.number, r.type, coalesce(r.device_time, r.created_at) as at, r.subtotal, r.discount_total, r.tax_total,
              r.service_charge, r.rounding, r.total, r.needs_review, r.store_id, r.points_earned, r.points_used,
              d.name as till, e.name as cashier, w.name as waiter, o.name as dining,
              t.table_id, tb.name as table_name, t.order_no, t.name as order_name, t.note, t.phone, t.address, t.covers,
              cu.id as customer_id, cu.name as customer, cu.phone as customer_phone, cu.email as customer_email,
              x.id as refund_id, x.number as refund_number,
              coalesce((select sum(f.total) from receipts f where f.tenant_id = r.tenant_id and f.refund_of = r.id
                          and f.type = 'refund' and f.deleted_at is null), 0) as refunded
         from receipts r
         left join tickets t on t.tenant_id = r.tenant_id and t.id = r.ticket_id
         left join tables tb on tb.tenant_id = r.tenant_id and tb.id = t.table_id
         left join dining_options o on o.tenant_id = r.tenant_id and o.id = t.dining_option_id
         left join customers cu on cu.tenant_id = r.tenant_id and cu.id = coalesce(r.customer_id, t.customer_id)
         left join receipts x on x.tenant_id = r.tenant_id and x.id = r.refund_of
         left join pos_devices d on d.tenant_id = r.tenant_id and d.id = r.device_id
         left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
         left join employees w on w.tenant_id = r.tenant_id and w.id = t.opened_by
        where r.tenant_id = $1 and r.id = $2 and r.deleted_at is null`,
      [tenantId, id],
    ),
    c.query(
      `select rl.id, rl.name_snapshot as name, rl.unit_price, rl.qty, rl.list_price, rl.price_label
         from receipt_lines rl where rl.tenant_id = $1 and rl.receipt_id = $2 and rl.deleted_at is null order by rl.created_at, rl.id`,
      [tenantId, id],
    ),
    c.query(
      `select m.receipt_line_id as line, m.name_snapshot as name, m.qty, m.price
         from receipt_line_modifiers m join receipt_lines rl on rl.tenant_id = m.tenant_id and rl.id = m.receipt_line_id
        where m.tenant_id = $1 and rl.receipt_id = $2 and m.deleted_at is null order by m.created_at, m.name_snapshot`,
      [tenantId, id],
    ),
    c.query(
      `select x.receipt_line_id as line, x.tax_id, x.name_snapshot as name, x.rate_bp, x.type
         from receipt_line_taxes x join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id
        where x.tenant_id = $1 and rl.receipt_id = $2 and x.deleted_at is null order by x.rate_bp desc, x.name_snapshot`,
      [tenantId, id],
    ),
    c.query(`select name_snapshot as name, amount from receipt_discounts where tenant_id = $1 and receipt_id = $2 and deleted_at is null order by created_at, id`, [tenantId, id]),
    c.query(
      `select p.payment_type_id as type, pt.name, pt.kind, p.amount, p.tendered, p.change, p.reference,
              case when p.payment_type_id <> p.original_payment_type_id then old.name end as was
         from receipt_payments_effective p
         left join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id
         left join payment_types old on old.tenant_id = p.tenant_id and old.id = p.original_payment_type_id
        where p.tenant_id = $1 and p.receipt_id = $2 order by p.amount desc, pt.name`,
      [tenantId, id],
    ),
    c.query(
      `select v.reason, v.detail, v.resolved_at, v.resolution from receipt_reviews v
        where v.tenant_id = $1 and v.receipt_id = $2 and v.deleted_at is null order by v.reason`,
      [tenantId, id],
    ),
    c.query(`select name, brn, vat_number from tenants where id = $1`, [tenantId]),
  ]);
  const h = hq.rows[0];
  if (!h) return null;
  const n = (v: unknown) => Number(v ?? 0);
  type M = { line: string; name: string; qty: number | null; price: string };
  type T = { line: string; tax_id: string | null; name: string; rate_bp: number; type: string };
  const mods = mq.rows as M[];
  const taxes = tq.rows as T[];
  const lines: Line[] = (lq.rows as { id: string; name: string; unit_price: string; qty: number; list_price: string | null; price_label: string | null }[]).map((l) => ({
    name: l.name,
    unit_price: n(l.unit_price),
    qty: l.qty,
    list_price: l.list_price === null ? null : n(l.list_price),
    price_label: l.price_label,
    addons: mods.filter((m) => m.line === l.id).map((m) => ({ name: m.name, qty: m.qty ?? 1, price: n(m.price) })),
    taxes: taxes.filter((t) => t.line === l.id).map((t) => ({ tax_id: t.tax_id, name: t.name, rate_bp: t.rate_bp, type: t.type })),
  }));
  const pays = pq.rows as (PayRow & { tendered: string | null; change: string })[];
  const head: Head = {
    number: h.number, type: h.type, at: new Date(h.at).toISOString(),
    subtotal: n(h.subtotal), discount_total: n(h.discount_total), tax_total: n(h.tax_total), service_charge: n(h.service_charge), rounding: n(h.rounding), total: n(h.total),
    table_id: h.table_id, table_name: h.table_name, order_no: h.order_no, order_name: h.order_name, note: h.note, phone: h.phone, address: h.address,
    covers: h.covers, dining: h.dining, cashier: h.cashier, waiter: h.waiter, customer: h.customer, refund_number: h.refund_number,
    points_earned: n(h.points_earned), points_used: n(h.points_used), refunded: n(h.refunded),
  };
  const doc = receiptDoc(
    head, lines, (dq.rows as { name: string; amount: string }[]).map((d): Disc => ({ name: d.name, amount: n(d.amount) })),
    pays.map((p): Pay => ({ name: p.name, amount: n(p.amount), tendered: p.tendered === null ? null : n(p.tendered), change: n(p.change), reference: p.reference })),
    retail,
  );
  const account = aq.rows[0] as { name: string | null; brn: string | null; vat_number: string | null } | undefined;
  const store = stores.find((b) => b.id === h.store_id) ?? null;
  const shop = shopOf(s, { name: account?.name ?? null, brn: account?.brn ?? null, vat: account?.vat_number ?? null }, store, stores.length > 1, retail);
  const design = readDesign("receipt", s.papers.receipt, retail).design;
  const logo = s.receipt.showLogo && s.receipt.logo ? s.receipt.logo : null;
  const paper = previewReceipt(design, doc, shop, COLUMNS, s.decimals, logo !== null);
  const logoBlock = design.blocks.find((b) => b.k === "logo");
  return {
    id: h.id, number: h.number, type: h.type, at: h.at, store_name: store && stores.length > 1 ? store.name : null, till: h.till, needs_review: h.needs_review,
    total: n(h.total), tax_total: n(h.tax_total),
    customer: h.customer_id ? { id: h.customer_id, name: h.customer, phone: h.customer_phone, email: h.customer_email } : null,
    refund_of: h.refund_id ? { id: h.refund_id, number: h.refund_number } : null,
    pays: pays.map((p) => ({ type: p.type, name: p.name, kind: p.kind, amount: n(p.amount), was: p.was, reference: p.reference })),
    reviews: vq.rows as Review[],
    paper: { lines: paper.lines, logoAt: paper.logoAt, logo, logoAlign: logoBlock?.align ?? "center" },
    text: paperText(previewReceipt(design, doc, shop, TEXT_COLUMNS, s.decimals, false).lines, TEXT_COLUMNS),
  };
}
