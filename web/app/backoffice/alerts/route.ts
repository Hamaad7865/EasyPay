import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";

// What the bell in the top bar holds: the things that need a look, across the
// whole account, each with the page where it is put right. They are the
// dashboard's "Needs attention" (counted the same way: receipts a till
// flagged, bookings to confirm, products with no tax, sold out, running low)
// and two the menu counts: invoices past their due day, and orders a till has
// left open since yesterday. The bell asks once a page is drawn, so no page
// waits for it. Each has an `id` that changes with its count, so one that
// grows is new again in the bell.

export const dynamic = "force-dynamic";

// $1 tenant
const SQL = `
  with tz as (
    select coalesce((select s.timezone from stores s where s.tenant_id = $1 and s.deleted_at is null order by s.created_at limit 1), 'Indian/Mauritius') as tz
  ),
  st as (
    select i.name, i.is_available,
           exists (select 1 from item_taxes it where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null) as taxed
      from items i where i.tenant_id = $1 and i.deleted_at is null
  ),
  -- what is low: as the dashboard counts it with All branches (each branch's own level when there are several)
  lw as (
    select i.name || case when nb.n > 1 then ' at ' || s.name else '' end as name,
           case when nb.n = 1 then coalesce(i.stock_qty, 0)
                else coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id and l.store_id = s.id), 0) end as q
      from items i left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
      join stores s on s.tenant_id = i.tenant_id and s.deleted_at is null
      cross join (select count(*) as n from stores z where z.tenant_id = $1 and z.deleted_at is null) nb
     where i.tenant_id = $1 and i.deleted_at is null and (i.track_stock or coalesce(c.is_stock, false))
  ),
  oo as (
    select t.id, t.created_at from tickets t
     where t.tenant_id = $1 and t.status = 'open' and t.deleted_at is null
       and (t.table_id is not null or exists (select 1 from ticket_lines l where l.tenant_id = t.tenant_id and l.ticket_id = t.id
                                                and l.voided_at is null and l.deleted_at is null and l.paid is not true))
  )
  select
    (select count(*)::int from receipts r
      where r.deleted_at is null and r.tenant_id = $1 and r.needs_review
        and (not exists (select 1 from receipt_reviews v where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)
          or exists (select 1 from receipt_reviews v where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null and v.resolved_at is null))) as flagged,
    (select count(*)::int from bookings b where b.tenant_id = $1 and b.deleted_at is null and b.status = 'pending' and b.booked_for > now() - interval '15 minutes') as pending,
    (select count(*)::int from st where not taxed) as no_tax,
    (select json_agg(x.name) from (select name from st where not taxed order by name limit 3) x) as no_tax_names,
    (select count(*)::int from st where not is_available) as sold_out,
    (select json_agg(x.name) from (select name from st where not is_available order by name limit 3) x) as sold_out_names,
    (select count(*)::int from lw where q <= 5000) as low,
    (select json_agg(x.name) from (select name from lw where q <= 5000 order by q, name limit 3) x) as low_names,
    (select count(*)::int from invoices where tenant_id = $1 and deleted_at is null and status = 'issued' and total > paid
        and invoice_due(issued_on, terms, due_on) < invoice_today(tenant_id, store_id)) as inv_late,
    (select count(*)::int from oo cross join tz where (oo.created_at at time zone tz.tz)::date < (now() at time zone tz.tz)::date) as stale`;

type Row = {
  flagged: number; pending: number; no_tax: number; no_tax_names: string[] | null; sold_out: number; sold_out_names: string[] | null;
  low: number; low_names: string[] | null; inv_late: number; stale: number;
};

export type Alert = { id: string; tone: "red" | "amber" | "plain"; title: string; text: string; href: string; go: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const some = (list: string[] | null, n: number) => {
  const l = list ?? [];
  return l.join(", ") + (n > l.length ? ` and ${n - l.length} more` : "");
};

export async function GET() {
  const ctx = await tenantContext();
  const r = await readTenant(ctx.tenantId, async (c) => (await c.query(SQL, [ctx.tenantId])).rows[0] as Row);
  const shop = ctx.mode === "retail";
  const thing = (n: number, verb: [string, string]) => plural(n, shop ? `product ${verb[0]}` : `item ${verb[0]}`, shop ? `products ${verb[1]}` : `items ${verb[1]}`);
  const out: Alert[] = [];
  if (r.flagged > 0)
    out.push({ id: `flagged-${r.flagged}`, tone: "red", title: `${plural(r.flagged, "receipt needs", "receipts need")} review`, text: "A till reported something that does not add up: a price that changed, a payment that was short or doubled.", href: "/backoffice/receipts", go: "Review receipts" });
  if (r.inv_late > 0)
    out.push({ id: `late-${r.inv_late}`, tone: "red", title: `${plural(r.inv_late, "invoice is", "invoices are")} overdue`, text: "Past the day they were due and not paid in full.", href: "/backoffice/invoices", go: "Open invoices" });
  // bookings are a page of the premium tier, and a restaurant's
  if (!shop && ctx.premium && r.pending > 0)
    out.push({ id: `pending-${r.pending}`, tone: "amber", title: `${plural(r.pending, "booking", "bookings")} to confirm`, text: "Nobody has confirmed them yet.", href: "/backoffice/bookings", go: "Open bookings" });
  if (r.stale > 0)
    out.push({ id: `stale-${r.stale}`, tone: "amber", title: `${plural(r.stale, shop ? "sale" : "order", shop ? "sales" : "orders")} left open since an earlier day`, text: shop ? "Still open on a till: paid and not closed, or forgotten." : "Still open on a till: a table not closed, or a bill not paid.", href: "/backoffice/reports/orders", go: shop ? "Open sales" : "Open orders" });
  if (r.no_tax > 0)
    out.push({ id: `notax-${r.no_tax}`, tone: "amber", title: `${thing(r.no_tax, ["has", "have"])} no tax set`, text: `${some(r.no_tax_names, r.no_tax)}. Pick the tax each one carries.`, href: "/backoffice/items?status=notax", go: "Set the tax" });
  if (r.sold_out > 0)
    out.push({ id: `out-${r.sold_out}`, tone: "plain", title: `${thing(r.sold_out, ["is", "are"])} sold out`, text: `${some(r.sold_out_names, r.sold_out)}. The tills grey them and will not sell them.`, href: "/backoffice/items?status=out", go: "Open the list" });
  if (r.low > 0)
    out.push({ id: `low-${r.low}`, tone: "plain", title: `${thing(r.low, ["is", "are"])} running low`, text: `${some(r.low_names, r.low)}: five or fewer left.`, href: "/backoffice/stock?show=low", go: "Open stock" });
  return Response.json({ alerts: out }, { headers: { "cache-control": "no-store" } });
}
