import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import type { Hit, HitGroup } from "./hits";

// The records side of the back office search (search-box.tsx finds the pages
// itself). It answers for the signed-in restaurant only, a few of each kind,
// and every result leads to a page that exists.
//
// The words come in the body, not the address: someone may be typing a
// guest's name or phone number, and addresses end up in logs.

export const dynamic = "force-dynamic";


const EACH = 5;
// % and _ mean "anything" to ILIKE: typed, they are just characters
const literal = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { q?: unknown } | null;
  const q = (typeof body?.q === "string" ? body.q : "").trim().slice(0, 60);
  if (q.length < 2) return Response.json({ groups: [] });
  const ctx = await tenantContext();
  const has = `%${literal(q)}%`;
  const starts = `${literal(q)}%`;

  const groups = await withTenant(ctx.tenantId, async (c) => {
    const rows = async <T,>(sql: string) => (await c.query(sql, [ctx.tenantId, has, starts])).rows as T[];
    const s = await loadSettings(c, ctx.tenantId);
    const out: HitGroup[] = [];
    const add = (kind: HitGroup["kind"], label: string, hits: Hit[]) => {
      if (hits.length) out.push({ kind, label, hits });
    };

    add(
      "items",
      "Items",
      (
        await rows<{ id: string; name: string; price: string; cat: string | null }>(
          `select i.id, i.name, i.price, k.name as cat
             from items i left join categories k on k.tenant_id = i.tenant_id and k.id = i.category_id
            where i.tenant_id = $1 and i.deleted_at is null
              and (i.name ilike $2 or i.sku ilike $2 or i.barcode ilike $2)
            order by (i.name ilike $3) desc, i.name limit ${EACH}`,
        )
      ).map((r) => ({ title: r.name, sub: `${r.cat ?? "No category"} · ${money(Number(r.price), s.decimals)}`, href: `/backoffice/items/edit?id=${r.id}` })),
    );

    add(
      "categories",
      "Categories",
      (
        await rows<{ id: string; name: string; n: number }>(
          `select k.id, k.name,
                  (select count(*)::int from items i where i.tenant_id = k.tenant_id and i.category_id = k.id and i.deleted_at is null) as n
             from categories k
            where k.tenant_id = $1 and k.deleted_at is null and k.name ilike $2
            order by (k.name ilike $3) desc, k.name limit ${EACH}`,
        )
      ).map((r) => ({ title: r.name, sub: r.n === 1 ? "1 item" : `${r.n} items`, href: `/backoffice/items?category=${r.id}` })),
    );

    add(
      "customers",
      "Customers",
      (
        await rows<{ name: string | null; phone: string | null; email: string | null }>(
          `select cu.name, cu.phone, cu.email
             from customers cu
            where cu.tenant_id = $1 and cu.deleted_at is null
              and (cu.name ilike $2 or cu.phone ilike $2 or cu.email ilike $2)
            order by (cu.name ilike $3) desc, cu.name limit ${EACH}`,
        )
      ).map((r) => {
        const title = r.name?.trim() || r.phone || r.email || "Customer";
        // the customers page finds its rows by the same words
        return { title, sub: [r.phone, r.email].filter(Boolean).join(" · ") || "No contact details", href: `/backoffice/customers?q=${encodeURIComponent(title.slice(0, 60))}` };
      }),
    );

    add(
      "tables",
      "Tables",
      (
        await rows<{ name: string; area: string | null; seats: number | null }>(
          `select t.name, t.area, t.seats
             from tables t
            where t.tenant_id = $1 and t.deleted_at is null and (t.name ilike $2 or t.area ilike $2)
            order by (t.name ilike $3) desc, t.area, t.sort_order, t.name limit ${EACH}`,
        )
      ).map((r) => ({
        title: r.name,
        sub: [r.area, r.seats ? `${r.seats} seats` : null].filter(Boolean).join(" · "),
        href: r.area ? `/backoffice/tables/plan?floor=${encodeURIComponent(r.area)}` : "/backoffice/tables",
      })),
    );

    // the staff page is for those who may edit staff, and so are its names here
    const mayStaff = (await c.query(`select has_perm($1, 'employees.edit') as ok`, [ctx.employeeId])).rows[0]?.ok as boolean;
    if (mayStaff) {
      add(
        "staff",
        "Staff",
        (
          await rows<{ name: string; role: string | null }>(
            `select e.name, r.name as role
               from employees e left join roles r on r.id = e.role_id
              where e.tenant_id = $1 and e.deleted_at is null and e.name ilike $2
              order by (e.name ilike $3) desc, e.name limit ${EACH}`,
          )
        ).map((r) => ({ title: r.name, sub: r.role ?? "No role", href: "/backoffice/staff" })),
      );
    }
    return out;
  });

  return Response.json({ groups });
}
