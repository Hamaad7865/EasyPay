import { revalidatePath } from "next/cache";
import { requirePerm, tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { fmtRs, parseRs } from "@/lib/money";

type ItemRow = {
  id: string;
  name: string;
  price: string;
  is_available: boolean;
  category_id: string | null;
  cat_name: string | null;
};

async function addItem(formData: FormData) {
  "use server";
  const ctx = await requirePerm("items.edit");
  const name = String(formData.get("name") ?? "").trim();
  const price = parseRs(String(formData.get("price") ?? ""));
  const categoryId = String(formData.get("category") ?? "") || null;
  if (!name || price === null) return;
  await withTenant(ctx.tenantId, (c) =>
    c.query(`insert into items (tenant_id, category_id, name, price) values ($1, $2, $3, $4)`, [
      ctx.tenantId,
      categoryId,
      name,
      price,
    ]),
  );
  revalidatePath("/backoffice/items");
}

async function saveItem(formData: FormData) {
  "use server";
  const ctx = await requirePerm("items.edit");
  const id = String(formData.get("id") ?? "");
  const price = parseRs(String(formData.get("price") ?? ""));
  const available = formData.get("available") === "on";
  if (!id || price === null) return;
  await withTenant(ctx.tenantId, (c) =>
    c.query(`update items set price = $1, is_available = $2 where id = $3 and tenant_id = $4`, [
      price,
      available,
      id,
      ctx.tenantId,
    ]),
  );
  revalidatePath("/backoffice/items");
}

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>;
}) {
  const ctx = await tenantContext();
  const sp = await searchParams;
  const cats = await withTenant(ctx.tenantId, (c) =>
    c
      .query(`select id, name from categories where deleted_at is null and tenant_id = $1 order by sort_order, name`, [
        ctx.tenantId,
      ])
      .then((r) => r.rows as { id: string; name: string }[]),
  );
  const items = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select i.id, i.name, i.price, i.is_available, i.category_id, c.name as cat_name
           from items i left join categories c on c.id = i.category_id and c.tenant_id = i.tenant_id
          where i.deleted_at is null and i.tenant_id = $2
            and ($1::uuid is null or i.category_id = $1::uuid)
          order by i.name`,
        [sp.cat || null, ctx.tenantId],
      )
      .then((r) => r.rows as ItemRow[]),
  );
  return (
    <div>
      <h1>Items</h1>
      <p>
        <a href="/backoffice/items">All</a>
        {cats.map((c) => (
          <span key={c.id}>
            {" "}
            · <a href={`/backoffice/items?cat=${c.id}`}>{c.name}</a>
          </span>
        ))}
      </p>
      <form action={addItem}>
        <input name="name" placeholder="Name" required />{" "}
        <input name="price" placeholder="Price Rs" required />{" "}
        <select name="category" defaultValue="">
          <option value="">No category</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>{" "}
        <button type="submit">Add item</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Price</th>
            <th>Available</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.name}</td>
              <td>{it.cat_name ?? "—"}</td>
              <td>
                <form action={saveItem} style={{ display: "inline" }}>
                  <input type="hidden" name="id" value={it.id} />
                  <input name="price" defaultValue={(Number(it.price) / 100).toString()} size={8} />{" "}
                  <label>
                    <input type="checkbox" name="available" defaultChecked={it.is_available} /> avail
                  </label>{" "}
                  <button type="submit">Save</button>
                </form>
              </td>
              <td>{fmtRs(Number(it.price))}</td>
              <td>{it.is_available ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
