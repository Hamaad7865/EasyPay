import { revalidatePath } from "next/cache";
import { requirePerm, tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { toHex } from "@/lib/colour";

const HEX = /^#[0-9a-f]{6}$/i;

async function addCategory(formData: FormData) {
  "use server";
  const ctx = await requirePerm("items.edit");
  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "");
  if (!name) return;
  await withTenant(ctx.tenantId, (c) =>
    c.query(`insert into categories (tenant_id, name, color) values ($1, $2, $3)`, [
      ctx.tenantId,
      name,
      HEX.test(color) ? color : null,
    ]),
  );
  revalidatePath("/backoffice/categories");
}

// The colour is what the till paints the category's button with.
async function setColor(formData: FormData) {
  "use server";
  const ctx = await requirePerm("items.edit");
  const id = String(formData.get("id") ?? "");
  const color = String(formData.get("color") ?? "");
  if (!HEX.test(color)) return;
  await withTenant(ctx.tenantId, (c) =>
    c.query(`update categories set color = $3 where tenant_id = $1 and id = $2 and deleted_at is null`, [
      ctx.tenantId,
      id,
      color,
    ]),
  );
  revalidatePath("/backoffice/categories");
}

export default async function CategoriesPage() {
  const ctx = await tenantContext();
  const rows = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select c.id, c.name, c.color, c.sort_order,
                (select count(*)::int from items i where i.category_id = c.id and i.tenant_id = c.tenant_id and i.deleted_at is null) as items
           from categories c where c.deleted_at is null and c.tenant_id = $1 order by c.sort_order, c.name`,
        [ctx.tenantId],
      )
      .then((r) => r.rows as { id: string; name: string; color: string | null; sort_order: number; items: number }[]),
  );
  return (
    <div>
      <h1>Categories</h1>
      <form action={addCategory} className="bo-toolbar">
        <input name="name" placeholder="New category" required />
        <input type="color" name="color" defaultValue="#5b6170" aria-label="Colour on the till" />
        <button type="submit">Add</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Items</th>
            <th>Colour on the till</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="swatch" style={{ background: toHex(r.color) ?? "#5b6170" }} />
                {r.name}
              </td>
              <td>{r.items}</td>
              <td>
                <form action={setColor} className="bo-toolbar" style={{ margin: 0 }}>
                  <input type="hidden" name="id" value={r.id} />
                  <input
                    type="color"
                    name="color"
                    defaultValue={toHex(r.color) ?? "#5b6170"}
                    aria-label={`Colour for ${r.name}`}
                  />
                  <button type="submit" className="btn-quiet">
                    Set colour
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">No categories yet.</p>}
    </div>
  );
}
