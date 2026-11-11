import type { PoolClient } from "pg";
import type { InvTax } from "@/lib/invoice-money";

// What the Invoices pages read (docs/superpowers/specs/2026-11-12-invoices-design.md). Each takes the
// tenant's own connection (readTenant / withTenant); nothing here writes.

export const PATH = "/backoffice/invoices";

export type ListRow = {
  id: string;
  number: string | null;
  status: "draft" | "issued";
  store_id: string;
  branch: string;
  customer_id: string | null;
  buyer_name: string;
  buyer_type: string;
  cust_ref: string | null;
  our_ref: string | null;
  issued_on: string;
  due_on: string;
  total: number;
  paid: number;
  lines: number;
  edited: string;
};

export async function listRows(c: PoolClient, tenantId: string, store: string | null): Promise<ListRow[]> {
  const r = await c.query(
    `select i.id, i.number, i.status, i.store_id, st.name as branch, i.customer_id, i.buyer_name, i.buyer_type, i.cust_ref, i.our_ref,
            i.issued_on::text as issued_on, invoice_due(i.issued_on, i.terms, i.due_on)::text as due_on,
            i.total::bigint as total, i.paid::bigint as paid, i.updated_at::text as edited,
            (select count(*)::int from invoice_lines l where l.tenant_id = i.tenant_id and l.invoice_id = i.id and l.kind = 'line') as lines
       from invoices i join stores st on st.tenant_id = i.tenant_id and st.id = i.store_id
      where i.tenant_id = $1 and i.deleted_at is null and ($2::uuid is null or i.store_id = $2::uuid)
      order by (i.status = 'draft') desc, i.issued_on desc, i.seq desc nulls first, i.updated_at desc
      limit 2000`,
    [tenantId, store],
  );
  return r.rows.map((x) => ({ ...x, total: Number(x.total), paid: Number(x.paid) })) as ListRow[];
}

// money received on invoices, day by day, for the strip on top of the list
export async function receivedOn(c: PoolClient, tenantId: string, day: string, store: string | null): Promise<number> {
  const r = await c.query(
    `select coalesce(sum(p.amount), 0)::bigint as n from invoice_payments p join invoices i on i.tenant_id = p.tenant_id and i.id = p.invoice_id
      where p.tenant_id = $1 and p.cancelled_at is null and p.paid_on = $2::date and ($3::uuid is null or i.store_id = $3::uuid)`,
    [tenantId, day, store],
  );
  return Number(r.rows[0].n);
}

export type Line = {
  id: string;
  kind: "line" | "heading" | "note";
  item_id: string | null;
  variant_id: string | null;
  name: string;
  detail: string | null;
  sku: string | null;
  qty: number;
  unit_price: number;
  list_price: number | null;
  taxes: InvTax[];
  unit_cost: number | null;
};
export type Payment = { id: string; paid_on: string; amount: number; method: string; reference: string | null; by: string | null; cancelled_at: string | null; cancelled_by: string | null };
export type Invoice = {
  id: string;
  status: "draft" | "issued";
  number: string | null;
  store_id: string;
  customer_id: string | null;
  buyer_type: "B2C" | "B2B" | "B2G";
  buyer_name: string;
  buyer_email: string | null;
  buyer_cc: string | null;
  buyer_phone: string | null;
  buyer_address: string | null;
  buyer_contact: string | null;
  buyer_brn: string | null;
  buyer_vat: string | null;
  deliver_to: string | null;
  issued_on: string;
  terms: string;
  due_on: string | null;
  due: string;
  cust_ref: string | null;
  our_ref: string | null;
  rep_id: string | null;
  rep: string | null;
  lang: "en" | "fr";
  show_excl: boolean;
  note: string | null;
  disc_type: "amount" | "percent";
  disc_value: number;
  subtotal: number;
  discount_total: number;
  tax_added: number;
  tax_total: number;
  total: number;
  paid: number;
  rev: number;
  issued_at: string | null;
  issued_by: string | null;
  made_by: string | null;
  lines: Line[];
  payments: Payment[];
};

const NUM = ["disc_value", "subtotal", "discount_total", "tax_added", "tax_total", "total", "paid"] as const;

export async function loadInvoice(c: PoolClient, tenantId: string, id: string): Promise<Invoice | null> {
  const [head, lines, pays] = await Promise.all([
    c.query(
      `select i.id, i.status, i.number, i.store_id, i.customer_id, i.buyer_type, i.buyer_name, i.buyer_email, i.buyer_cc, i.buyer_phone, i.buyer_address,
              i.buyer_contact, i.buyer_brn, i.buyer_vat, i.deliver_to, i.issued_on::text as issued_on, i.terms, i.due_on::text as due_on,
              invoice_due(i.issued_on, i.terms, i.due_on)::text as due, i.cust_ref, i.our_ref, i.rep_id, r.name as rep, i.lang, i.show_excl, i.note,
              i.disc_type, i.disc_value, i.subtotal, i.discount_total, i.tax_added, i.tax_total, i.total, i.paid, i.rev,
              i.issued_at::text as issued_at, ib.name as issued_by, mb.name as made_by
         from invoices i
         left join employees r on r.tenant_id = i.tenant_id and r.id = i.rep_id
         left join employees ib on ib.tenant_id = i.tenant_id and ib.id = i.issued_by
         left join employees mb on mb.tenant_id = i.tenant_id and mb.id = i.created_by
        where i.tenant_id = $1 and i.id = $2 and i.deleted_at is null`,
      [tenantId, id],
    ),
    c.query(
      `select id, kind, item_id, variant_id, name, detail, sku, qty, unit_price, list_price, taxes, unit_cost
         from invoice_lines where tenant_id = $1 and invoice_id = $2 order by pos`,
      [tenantId, id],
    ),
    c.query(
      `select p.id, p.paid_on::text as paid_on, p.amount, p.method, p.reference, e.name as by, p.cancelled_at::text as cancelled_at, x.name as cancelled_by
         from invoice_payments p
         left join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
         left join employees x on x.tenant_id = p.tenant_id and x.id = p.cancelled_by
        where p.tenant_id = $1 and p.invoice_id = $2 order by p.paid_on, p.created_at`,
      [tenantId, id],
    ),
  ]);
  const h = head.rows[0];
  if (!h) return null;
  for (const k of NUM) h[k] = Number(h[k]);
  return {
    ...h,
    lines: lines.rows.map((l) => ({ ...l, qty: Number(l.qty), unit_price: Number(l.unit_price), list_price: l.list_price === null ? null : Number(l.list_price), unit_cost: l.unit_cost === null ? null : Number(l.unit_cost) })),
    payments: pays.rows.map((p) => ({ ...p, amount: Number(p.amount) })),
  } as Invoice;
}

// ---- finding a product: name, SKU or barcode ----
export type Found = {
  item_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  taxes: InvTax[];
  // what the branch holds, null when nobody counts it
  stock: number | null;
  cost: number | null;
  variants: number;
};

// A product as an invoice takes it: its price at this branch, its taxes, and what the branch holds of it.
// A product with variants is found as each of its variants; typing a variant's barcode finds that one.
export async function findProducts(c: PoolClient, tenantId: string, q: string, store: string, costs: boolean): Promise<Found[]> {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return [];
  const r = await c.query(
    `with hit as (
       select i.id as item_id, v.id as variant_id,
              case when v.id is null then i.name else i.name || ' ' || v.name end as name,
              coalesce(v.sku, i.sku) as sku, coalesce(v.barcode, i.barcode) as barcode,
              coalesce(v.price, o.price, i.price)::bigint as price,
              coalesce(v.cost, i.cost) as cost,
              -- a made-of product is not counted itself (its parts are): no warning on it, as stockOf
              (i.track_stock or coalesce(cat.is_stock, false)) as counted,
              (select count(*)::int from item_variants x where x.tenant_id = i.tenant_id and x.item_id = i.id and x.deleted_at is null) as variants,
              case when coalesce(v.barcode, i.barcode) = $3 or lower(coalesce(v.sku, i.sku, '')) = $3 then 0 else 1 end as exact
         from items i
         left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
         left join categories cat on cat.tenant_id = i.tenant_id and cat.id = i.category_id
         left join store_item_overrides o on o.tenant_id = i.tenant_id and o.store_id = $2::uuid and o.item_id = i.id and o.deleted_at is null
        where i.tenant_id = $1 and i.deleted_at is null
          and (coalesce(v.barcode, i.barcode) = $3 or lower(coalesce(v.sku, i.sku, '')) = $3
               or (select bool_and(lower(i.name || ' ' || coalesce(v.name, '') || ' ' || coalesce(v.sku, i.sku, '') || ' ' || coalesce(i.brand, '')) like '%' || w || '%')
                     from unnest($4::text[]) w))
     )
     select h.*, coalesce((select jsonb_agg(jsonb_build_object('tax_id', t.id, 'name', t.name, 'rate_bp', t.rate_bp, 'type', t.type) order by t.name)
                             from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id and t.deleted_at is null
                            where it.tenant_id = $1 and it.item_id = h.item_id), '[]'::jsonb) as taxes,
            case when h.counted then coalesce((select sum(sl.qty) from stock_levels sl where sl.tenant_id = $1 and sl.store_id = $2::uuid
                                                 and sl.item_id = h.item_id and sl.variant_id is not distinct from h.variant_id), 0) end as stock
       from hit h
      order by h.exact, length(h.name), h.name
      limit 12`,
    [tenantId, store, q.trim().toLowerCase(), words],
  );
  return r.rows.map((x) => ({
    item_id: x.item_id,
    variant_id: x.variant_id,
    name: x.name,
    sku: x.sku,
    barcode: x.barcode,
    price: Number(x.price),
    taxes: x.taxes,
    stock: x.stock === null ? null : Number(x.stock),
    cost: costs && x.cost !== null ? Number(x.cost) : null,
    variants: x.variants,
  }));
}

// what a branch holds of the products on an invoice, for the warning on each line
export async function stockOf(c: PoolClient, tenantId: string, store: string, keys: { item_id: string; variant_id: string | null }[]): Promise<Record<string, number | null>> {
  if (keys.length === 0) return {};
  const r = await c.query(
    `select k.item_id, k.variant_id,
            case when i.track_stock or coalesce(cat.is_stock, false) then
              coalesce((select sum(sl.qty) from stock_levels sl where sl.tenant_id = $1 and sl.store_id = $2::uuid and sl.item_id = k.item_id
                          and sl.variant_id is not distinct from k.variant_id), 0) end as stock
       from jsonb_to_recordset($3::jsonb) as k(item_id uuid, variant_id uuid)
       join items i on i.tenant_id = $1 and i.id = k.item_id
       left join categories cat on cat.tenant_id = i.tenant_id and cat.id = i.category_id`,
    [tenantId, store, JSON.stringify(keys)],
  );
  return Object.fromEntries(r.rows.map((x) => [`${x.item_id}|${x.variant_id ?? ""}`, x.stock === null ? null : Number(x.stock)]));
}

// ---- customers ----
export type Details = {
  buyer_type: "B2C" | "B2B" | "B2G";
  address: string | null;
  brn: string | null;
  vat_no: string | null;
  lang: "en" | "fr" | null;
  email_cc: string | null;
  contact: string | null;
  deliver_to: string | null;
  terms: string | null;
};
export type CustomerHit = { id: string; name: string; phone: string | null; email: string | null; details: Details | null };

export async function findCustomers(c: PoolClient, tenantId: string, q: string): Promise<CustomerHit[]> {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const r = await c.query(
    `select cu.id, cu.name, cu.phone, cu.email,
            (select to_jsonb(d) - 'id' - 'tenant_id' - 'customer_id' - 'created_at' - 'updated_at' from invoice_customers d where d.tenant_id = cu.tenant_id and d.customer_id = cu.id) as details
       from customers cu
      where cu.tenant_id = $1 and cu.deleted_at is null
        and (lower(cu.name) like '%' || $2 || '%' or regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g') like '%' || regexp_replace($2, '\\D', '', 'g') || '%' and length(regexp_replace($2, '\\D', '', 'g')) >= 3
             or lower(coalesce(cu.email, '')) like '%' || $2 || '%'
             or exists (select 1 from invoice_customers d where d.tenant_id = cu.tenant_id and d.customer_id = cu.id and lower(coalesce(d.brn, '')) = $2))
      order by (lower(cu.name) like $2 || '%') desc, lower(cu.name)
      limit 10`,
    [tenantId, t],
  );
  return r.rows as CustomerHit[];
}

export type Glance = {
  name: string;
  phone: string | null;
  email: string | null;
  // bills on account (0114), from the tablet
  billsOwed: number;
  billsOverdue: number;
  // this customer's issued invoices
  invoicesOwed: number;
  invoicesOverdue: number;
  overdueCount: number;
  accountDays: number;
  last: { id: string; number: string; issued_on: string; total: number; paid: number; due: string }[];
  // what they buy most, the last price they paid and when
  often: { item_id: string; variant_id: string | null; name: string; sku: string | null; times: number; last_price: number; last_on: string; taxes: InvTax[] }[];
};

// The customer at a glance, beside the invoice: what they owe, what is late, what they buy.
export async function glance(c: PoolClient, tenantId: string, customerId: string, accountDays: number): Promise<Glance | null> {
  const [who, bills, invs, last, often] = await Promise.all([
    c.query(`select name, phone, email from customers where tenant_id = $1 and id = $2`, [tenantId, customerId]),
    c.query(
      `select coalesce(sum(account_owed(b)), 0)::bigint as owed,
              coalesce(sum(account_owed(b)) filter (where deposit_today(b.tenant_id, b.store_id) - b.day > $3), 0)::bigint as late
         from account_bills b where b.tenant_id = $1 and b.customer_id = $2 and b.deleted_at is null`,
      [tenantId, customerId, accountDays],
    ),
    c.query(
      `select coalesce(sum(i.total - i.paid), 0)::bigint as owed,
              coalesce(sum(i.total - i.paid) filter (where invoice_due(i.issued_on, i.terms, i.due_on) < invoice_today(i.tenant_id, i.store_id)), 0)::bigint as late,
              count(*) filter (where invoice_due(i.issued_on, i.terms, i.due_on) < invoice_today(i.tenant_id, i.store_id))::int as n
         from invoices i where i.tenant_id = $1 and i.customer_id = $2 and i.status = 'issued' and i.deleted_at is null and i.total > i.paid`,
      [tenantId, customerId],
    ),
    c.query(
      `select i.id, i.number, i.issued_on::text as issued_on, i.total, i.paid, invoice_due(i.issued_on, i.terms, i.due_on)::text as due
         from invoices i where i.tenant_id = $1 and i.customer_id = $2 and i.status = 'issued' and i.deleted_at is null
        order by i.issued_on desc, i.seq desc limit 5`,
      [tenantId, customerId],
    ),
    // a year of their receipts (the tills) and invoices, product by product
    c.query(
      `with bought as (
         select tl.item_id, tl.variant_id, rl.name_snapshot as name, rl.unit_price as price, r.created_at::date as day
           from receipt_lines rl
           join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id and r.type = 'sale' and r.deleted_at is null
           join tickets t on t.tenant_id = r.tenant_id and t.id = r.ticket_id
           join ticket_lines tl on tl.tenant_id = rl.tenant_id and tl.id = rl.ticket_line_id
          where rl.tenant_id = $1 and t.customer_id = $2 and r.created_at > now() - interval '365 days' and tl.item_id is not null
         union all
         select l.item_id, l.variant_id, l.name, l.unit_price, i.issued_on
           from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
          where l.tenant_id = $1 and i.customer_id = $2 and i.status = 'issued' and l.kind = 'line' and l.item_id is not null
            and i.issued_on > current_date - 365
       ), ranked as (
         select item_id, variant_id, count(*)::int as times,
                (array_agg(price order by day desc))[1] as last_price, max(day)::text as last_on, (array_agg(name order by day desc))[1] as name
           from bought group by item_id, variant_id
       )
       select k.*, coalesce(v.sku, it.sku) as sku,
              coalesce((select jsonb_agg(jsonb_build_object('tax_id', t.id, 'name', t.name, 'rate_bp', t.rate_bp, 'type', t.type) order by t.name)
                          from item_taxes x join taxes t on t.tenant_id = x.tenant_id and t.id = x.tax_id and t.deleted_at is null
                         where x.tenant_id = $1 and x.item_id = k.item_id), '[]'::jsonb) as taxes
         from ranked k
         join items it on it.tenant_id = $1 and it.id = k.item_id and it.deleted_at is null
         left join item_variants v on v.tenant_id = $1 and v.id = k.variant_id
        order by k.times desc, k.last_on desc
        limit 8`,
      [tenantId, customerId],
    ),
  ]);
  const w = who.rows[0];
  if (!w) return null;
  return {
    name: w.name,
    phone: w.phone,
    email: w.email,
    billsOwed: Number(bills.rows[0].owed),
    billsOverdue: Number(bills.rows[0].late),
    invoicesOwed: Number(invs.rows[0].owed),
    invoicesOverdue: Number(invs.rows[0].late),
    overdueCount: invs.rows[0].n,
    accountDays,
    last: last.rows.map((x) => ({ ...x, total: Number(x.total), paid: Number(x.paid) })),
    often: often.rows.map((x) => ({ ...x, last_price: Number(x.last_price) })),
  };
}

// ---- the set-up ----
export type Setup = { bank_name: string; account_name: string; account_no: string; swift: string; terms: string; lang: "en" | "fr"; footer: string };
export const NO_SETUP: Setup = { bank_name: "", account_name: "", account_no: "", swift: "", terms: "receipt", lang: "en", footer: "" };

export async function loadSetup(c: PoolClient, tenantId: string): Promise<Setup> {
  const r = (await c.query(`select bank_name, account_name, account_no, swift, terms, lang, footer from invoice_setup where tenant_id = $1`, [tenantId])).rows[0];
  if (!r) return NO_SETUP;
  return { bank_name: r.bank_name ?? "", account_name: r.account_name ?? "", account_no: r.account_no ?? "", swift: r.swift ?? "", terms: r.terms, lang: r.lang, footer: r.footer ?? "" };
}

export type Series = { store_id: string; branch: string; code: string; prefix: string; start_no: number; next_no: number; issued: number };

// each branch's numbers: the ones made already, and what a branch with none yet would start with
export async function loadSeries(c: PoolClient, tenantId: string): Promise<Series[]> {
  const r = await c.query(
    `select st.id as store_id, st.name as branch, st.code, s.prefix, coalesce(s.start_no, 1) as start_no, coalesce(s.next_no, 1) as next_no,
            (select count(*)::int from invoices i where i.tenant_id = st.tenant_id and i.store_id = st.id and i.status = 'issued') as issued,
            (select count(*) from stores x where x.tenant_id = st.tenant_id and x.deleted_at is null) as many
       from stores st left join invoice_series s on s.tenant_id = st.tenant_id and s.store_id = st.id
      where st.tenant_id = $1 and st.deleted_at is null
      order by st.created_at, st.id`,
    [tenantId],
  );
  return r.rows.map((x) => ({
    store_id: x.store_id,
    branch: x.branch,
    code: x.code,
    prefix: x.prefix ?? (Number(x.many) > 1 ? `INV-${String(x.code).toUpperCase().replace(/[^A-Z0-9]/g, "")}-`.slice(0, 16) : "INV-"),
    start_no: x.start_no,
    next_no: x.next_no,
    issued: x.issued,
  }));
}

export const numberOf = (prefix: string, n: number) => prefix + String(n).padStart(5, "0");

// The business on paper: as Company details keeps it, the branch's address and phone where it has its own.
export type Seller = { name: string; legal: string; address: string; phone: string; brn: string; vat: string; logo: string | null; branch: string | null };

export async function sellerOf(c: PoolClient, tenantId: string, store: string, company: { name: string; brn: string; vat: string; address: string; phone: string }, logo: string | null): Promise<Seller> {
  const r = (
    await c.query(
      `select t.name, t.legal_name, t.brn, t.vat_number, st.name as branch, st.address, st.phone,
              (select count(*) from stores x where x.tenant_id = t.id and x.deleted_at is null)::int as stores
         from tenants t join stores st on st.tenant_id = t.id and st.id = $2
        where t.id = $1`,
      [tenantId, store],
    )
  ).rows[0];
  return {
    // as Company details shows it: the business's name, BRN and VAT on the tenant, the rest in its settings
    name: r?.name || company.name || "",
    legal: r?.legal_name && r.legal_name !== r.name ? r.legal_name : "",
    address: r?.address || company.address || "",
    phone: r?.phone || company.phone || "",
    brn: r?.brn ?? company.brn ?? "",
    vat: r?.vat_number ?? company.vat ?? "",
    logo,
    branch: r && r.stores > 1 ? r.branch : null,
  };
}
