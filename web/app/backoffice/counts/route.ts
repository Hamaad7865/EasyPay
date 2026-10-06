import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import type { NavCount } from "../nav";

// The numbers beside the pages in the menu: how many rows each list page
// shows, counted the way the page itself selects them, so the badge and the
// page never disagree. The menu asks for them once the page is drawn (and
// again on arriving on another page, and after a save), so no page waits for them. Two pages do not list
// everything they hold, and count what there is to act on instead: Bookings
// the ones from today on (what it opens on), Receipts the ones a till flagged
// and nobody has signed off (only when there are any, and in red).

export const dynamic = "force-dynamic";

// $1 tenant
const SQL = `
  select (select count(*)::int from categories where tenant_id = $1 and deleted_at is null) as categories,
         (select count(*)::int from items where tenant_id = $1 and deleted_at is null) as items,
         (select count(*)::int from modifier_groups where tenant_id = $1 and deleted_at is null) as addons,
         (select count(*)::int from taxes where tenant_id = $1 and deleted_at is null) as taxes,
         (select count(*)::int from discounts where tenant_id = $1 and deleted_at is null) as discounts,
         (select count(*)::int from items i left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
           where i.tenant_id = $1 and i.deleted_at is null and (i.track_stock or coalesce(c.is_stock, false))) as stock,
         (select count(*)::int from tables where tenant_id = $1 and deleted_at is null) as tables,
         (select count(*)::int from bookings bk join stores s on s.tenant_id = bk.tenant_id and s.id = bk.store_id
           where bk.tenant_id = $1 and bk.deleted_at is null
             and (bk.booked_for at time zone s.timezone)::date >= (now() at time zone s.timezone)::date) as bookings,
         (select count(*)::int from customers where tenant_id = $1 and deleted_at is null) as customers,
         (select count(*)::int from printers where tenant_id = $1 and deleted_at is null) as printers,
         (select count(*)::int from employees where tenant_id = $1 and deleted_at is null) as staff,
         (select count(*)::int from roles where tenant_id = $1 and deleted_at is null) as roles,
         -- flagged = still open: no recorded reason yet, or a reason not resolved (as the dashboard counts them)
         (select count(*)::int from receipts r
           where r.deleted_at is null and r.tenant_id = $1 and r.needs_review
             and (not exists (select 1 from receipt_reviews v
                               where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)
               or exists (select 1 from receipt_reviews v
                           where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null
                             and v.resolved_at is null))) as flagged`;

export async function GET() {
  const ctx = await tenantContext();
  const r = await readTenant(ctx.tenantId, async (c) => (await c.query(SQL, [ctx.tenantId])).rows[0] as Record<string, number>);
  const counts: Record<string, NavCount> = {};
  const put = (href: string, n: number, one: string, many: string) => {
    counts[href] = { n, say: `${n} ${n === 1 ? one : many}` };
  };
  put("/backoffice/categories", r.categories, "category", "categories");
  put("/backoffice/items", r.items, "item", "items");
  put("/backoffice/addons", r.addons, "add-on group", "add-on groups");
  put("/backoffice/taxes", r.taxes, "tax", "taxes");
  put("/backoffice/discounts", r.discounts, "discount", "discounts");
  put("/backoffice/stock", r.stock, "item counted", "items counted");
  put("/backoffice/tables", r.tables, "table", "tables");
  put("/backoffice/bookings", r.bookings, "booking from today on", "bookings from today on");
  put("/backoffice/customers", r.customers, "customer", "customers");
  put("/backoffice/printers", r.printers, "printer", "printers");
  put("/backoffice/staff", r.staff, "member of staff", "members of staff");
  put("/backoffice/roles", r.roles, "role", "roles");
  if (r.flagged > 0) counts["/backoffice/receipts"] = { n: r.flagged, say: `${r.flagged} ${r.flagged === 1 ? "receipt" : "receipts"} to review`, tone: "red" };
  return Response.json({ counts }, { headers: { "cache-control": "no-store" } });
}
