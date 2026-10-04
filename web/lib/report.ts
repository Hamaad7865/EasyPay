import type { PoolClient } from "pg";
import { UUID } from "@/lib/action";

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
export async function lists(c: PoolClient, tenantId: string): Promise<Lists> {
  const rows = async (sql: string) => (await c.query(sql, [tenantId])).rows as { id: string; name: string }[];
  const tz = (await c.query(`select timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [tenantId])).rows[0]?.timezone as string | undefined;
  return {
    tz: tz ?? "Indian/Mauritius",
    employees: await rows(`select id, name from employees where tenant_id = $1 order by name`),
    dining: await rows(`select id, name from dining_options where tenant_id = $1 order by sort_order, name`),
    payments: await rows(`select id, name from payment_types where tenant_id = $1 order by sort_order, name`),
    taxes: await rows(`select id, name from taxes where tenant_id = $1 order by rate_bp desc, name`),
  };
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
