import { revalidatePath } from "next/cache";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";

async function addCategory(formData: FormData) {
  "use server";
  const ctx = await tenantContext();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await withTenant(ctx.tenantId, (c) =>
    c.query(`insert into categories (tenant_id, name) values ($1, $2)`, [ctx.tenantId, name]),
  );
  revalidatePath("/backoffice/categories");
}

export default async function CategoriesPage() {
  const ctx = await tenantContext();
  const rows = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select c.id, c.name, c.sort_order,
                (select count(*)::int from items i where i.category_id = c.id and i.tenant_id = c.tenant_id and i.deleted_at is null) as items
           from categories c where c.deleted_at is null and c.tenant_id = $1 order by c.sort_order, c.name`,
        [ctx.tenantId],
      )
      .then((r) => r.rows as { id: string; name: string; sort_order: number; items: number }[]),
  );
  return (
    <div>
      <h1>Categories</h1>
      <form action={addCategory}>
        <input name="name" placeholder="New category" required /> <button type="submit">Add</button>
      </form>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            {r.name} — {r.items} items
          </li>
        ))}
      </ul>
    </div>
  );
}
