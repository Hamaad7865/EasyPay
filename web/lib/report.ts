import type { PoolClient } from "pg";
import { UUID } from "@/lib/action";
import { type PosSettings, withDefaults } from "@/lib/settings";

// What every report starts from: the receipts that count as a sale or a
// refund (a double payment does not), each with its moment on the till's own
// clock, its day in the store's timezone, and the order it belongs to.
// $1 tenant, $2 from day, $3 to day, $4 employee or null, $5 order type or
// null, $6 'sale' | 'refund' | 'all'.
export const RECEIPTS = `
  select v.id, v.number, v.type, v.refund_of, v.ticket_id, v.device_id, v.employee_id,
         v.subtotal, v.discount_total, v.tax_total, v.rounding, v.total, v.signed_total, v.needs_review,
         case when v.type = 'refund' then -1 else 1 end as sign,
         coalesce(v.device_time, v.created_at) as at,
         (coalesce(v.device_time, v.created_at) at time zone s.timezone)::date as day,
         s.timezone,
         coalesce(t.dining_option_id, dd.id) as dining_option_id, t.table_id, t.name as order_name, t.opened_by, t.covers, t.note
    from receipt_revenue v
    join stores s on s.tenant_id = v.tenant_id and s.id = v.store_id
    left join tickets t on t.tenant_id = v.tenant_id and t.id = v.ticket_id
    left join lateral (select d.id from dining_options d where d.tenant_id = v.tenant_id and d.is_default and d.deleted_at is null limit 1) dd on true
   where v.tenant_id = $1 and v.counts_as_sale
     and (coalesce(v.device_time, v.created_at) at time zone s.timezone)::date between $2::date and $3::date
     and ($4::uuid is null or v.employee_id = $4::uuid)
     and ($5::uuid is null or coalesce(t.dining_option_id, dd.id) = $5::uuid)
     and ($6::text = 'all' or v.type = $6::text)`;

export type Filters = { from: string; to: string; employee: string | null; dining: string | null; kind: "sale" | "refund" | "all"; payment: string | null; tax: string | null; group: "item" | "category" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

// Today in the restaurant's timezone, so "today" is the restaurant's day and
// not the server's.
export function today(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function filters(sp: Record<string, string | string[] | undefined>, tz: string): Filters {
  const t = today(tz);
  let from = DAY.test(first(sp.from)) ? first(sp.from) : t;
  let to = DAY.test(first(sp.to)) ? first(sp.to) : from > t ? from : t;
  if (!DAY.test(first(sp.to)) && DAY.test(first(sp.from))) to = first(sp.from) > t ? first(sp.from) : t;
  if (to < from) [from, to] = [to, from];
  const id = (k: string) => (UUID.test(first(sp[k])) ? first(sp[k]) : null);
  const kind = first(sp.kind);
  return {
    from,
    to,
    employee: id("employee"),
    dining: id("dining"),
    kind: kind === "sale" || kind === "refund" ? kind : "all",
    payment: id("payment"),
    tax: id("tax"),
    group: first(sp.group) === "category" ? "category" : "item",
  };
}

export const args = (tenantId: string, f: Filters) => [tenantId, f.from, f.to, f.employee, f.dining, f.kind];

export type Lists = {
  tz: string;
  employees: { id: string; name: string }[];
  dining: { id: string; name: string }[];
  payments: { id: string; name: string }[];
  taxes: { id: string; name: string }[];
};

// The choices the filter bars offer. Someone who has left, or a payment type
// that was removed, is still offered: their sales are still in the reports.
// All five lists come back from one query: every query is a trip to the
// database and back, and these were five of them at the top of every report.
const list = (from: string, order: string) =>
  `coalesce((select json_agg(json_build_object('id', x.id, 'name', x.name) order by ${order}) from ${from} x where x.tenant_id = $1), '[]'::json)`;
const LISTS = `(select timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1) as tz,
              ${list("employees", "x.name")} as employees,
              ${list("dining_options", "x.sort_order, x.name")} as dining,
              ${list("payment_types", "x.sort_order, x.name")} as payments,
              ${list("taxes", "x.rate_bp desc, x.name")} as taxes`;
type ListsRow = Omit<Lists, "tz"> & { tz: string | null };
const asLists = (r: ListsRow): Lists => ({ tz: r.tz ?? "Indian/Mauritius", employees: r.employees, dining: r.dining, payments: r.payments, taxes: r.taxes });

export async function lists(c: PoolClient, tenantId: string): Promise<Lists> {
  return asLists((await c.query(`select ${LISTS}`, [tenantId])).rows[0] as ListsRow);
}

// What every report asks before its figures: the filters' choices, whether
// this person may see reports, and the POS settings. One round trip for the
// three, where they were seven.
export async function reportStart(c: PoolClient, tenantId: string, employeeId: string): Promise<{ l: Lists; ok: boolean; s: PosSettings }> {
  const r = (
    await c.query(
      `select ${LISTS},
              has_perm($2, 'reports.view') as ok,
              (select data from pos_settings where tenant_id = $1 and deleted_at is null) as settings`,
      [tenantId, employeeId],
    )
  ).rows[0] as ListsRow & { ok: boolean | null; settings: unknown };
  return { l: asLists(r), ok: Boolean(r.ok), s: withDefaults(r.settings) };
}

// What a page of figures needs before its first figure: the restaurant's
// time zone, whether this person may see reports, and the POS settings (for
// how money is written). One round trip.
export async function basics(c: PoolClient, tenantId: string, employeeId: string): Promise<{ tz: string; ok: boolean; settings: unknown }> {
  const r = (
    await c.query(
      `select (select timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1) as tz,
              has_perm($2, 'reports.view') as ok,
              (select data from pos_settings where tenant_id = $1 and deleted_at is null) as settings`,
      [tenantId, employeeId],
    )
  ).rows[0] as { tz: string | null; ok: boolean | null; settings: unknown };
  return { tz: r.tz ?? "Indian/Mauritius", ok: Boolean(r.ok), settings: r.settings };
}

export const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
export const fmtQty = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
export function clock(tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  return (v: string | Date | null) => (v ? f.format(new Date(v)) : "");
}

// Reports are for those allowed to see them (the owner always is).
export async function canView(c: PoolClient, employeeId: string): Promise<boolean> {
  return Boolean((await c.query(`select has_perm($1, 'reports.view') as ok`, [employeeId])).rows[0]?.ok);
}
