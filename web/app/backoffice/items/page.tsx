import Link from "next/link";
import { Plus, UtensilsCrossed } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, on, Refused, uuid } from "@/lib/action";
import { parseRs } from "@/lib/money";
import { loadSettings, money } from "@/lib/settings";
import { Empty, Flash, one, PageHead, type Search } from "../ui";

type ItemRow = {
  id: string;
  name: string;
  price: string;
  is_available: boolean;
  cat_name: string | null;
  tax: string | null;
  addons: number;
};

// Price and availability are what change day to day, so they are edited in
// the list; everything else is on the item's own page.
async function quickSave(f: FormData) {
  "use server";
  const back = String(f.get("back") ?? "/backoffice/items");
  await act("items.edit", back.startsWith("/backoffice/items") ? back : "/backoffice/items", async (c, ctx) => {
    const id = uuid(f, "id");
    const price = parseRs(String(f.get("price") ?? ""));
    if (price === null) throw new Refused("The price is not a number.");
    await c.query(`update items set price = $3, is_available = $4 where tenant_id = $1 and id = $2 and deleted_at is null`, [
      ctx.tenantId,
      id,
      price,
      on(f, "available"),
    ]);
    return "Item saved.";
  });
}

export default async function ItemsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const cat = one(sp.category) || one(sp.cat);
  const q = one(sp.q).trim();
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => ({
    settings: await loadSettings(c, ctx.tenantId),
    cats: (
      await c.query(`select id, name from categories where deleted_at is null and tenant_id = $1 order by sort_order, name`, [ctx.tenantId])
    ).rows as { id: string; name: string }[],
    items: (
      await c.query(
        `select i.id, i.name, i.price, i.is_available, c.name as cat_name,
                (select string_agg(t.name, ', ') from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id
                  where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null) as tax,
                (select count(*)::int from item_modifier_groups g where g.tenant_id = i.tenant_id and g.item_id = i.id and g.deleted_at is null) as addons
           from items i left join categories c on c.id = i.category_id and c.tenant_id = i.tenant_id
          where i.deleted_at is null and i.tenant_id = $1
            and ($2::uuid is null or i.category_id = $2::uuid)
            and ($3 = '' or i.name ilike '%' || $3 || '%')
          order by c.sort_order nulls last, i.name`,
        [ctx.tenantId, /^[0-9a-f-]{36}$/i.test(cat) ? cat : null, q],
      )
    ).rows as ItemRow[],
  }));
  const here = "/backoffice/items" + (cat ? `?category=${cat}` : "");
  return (
    <div>
      <PageHead title="Items" lede="What the till sells. Change a price or mark something sold out here; open an item for its tax, add-ons and category.">
        <Link href="/backoffice/items/edit" className="btn">
          <Plus aria-hidden="true" />
          Add item
        </Link>
      </PageHead>
      <Flash sp={sp} />
      <p className="bo-chips">
        <Link href="/backoffice/items" className={cat ? undefined : "on"}>All</Link>
        {d.cats.map((c) => (
          <Link key={c.id} href={`/backoffice/items?category=${c.id}`} className={cat === c.id ? "on" : undefined}>{c.name}</Link>
        ))}
      </p>
      <form className="bo-toolbar" action="/backoffice/items">
        {cat && <input type="hidden" name="category" value={cat} />}
        <input name="q" defaultValue={q} placeholder="Search items" style={{ minWidth: 260 }} />
        <button type="submit" className="btn-quiet">Search</button>
      </form>
      {d.items.length === 0 ? (
        <Empty icon={UtensilsCrossed} title={q ? "No item matches that search" : "No items here yet"}>
          <Link href="/backoffice/items/edit">Add the first one</Link>
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>Tax</th>
              <th>Add-ons</th>
              <th className="num">Price</th>
              <th>Change price</th>
              <th>On sale</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.items.map((it) => (
              <tr key={it.id}>
                <td><Link href={`/backoffice/items/edit?id=${it.id}`} className="strong">{it.name}</Link></td>
                <td>{it.cat_name ?? <span className="muted">None</span>}</td>
                <td>{it.tax ?? <span className="badge amber">No tax set</span>}</td>
                <td>{it.addons > 0 ? `${it.addons} ${it.addons === 1 ? "group" : "groups"}` : <span className="muted">None</span>}</td>
                <td className="num">{money(Number(it.price), d.settings.decimals)}</td>
                <td><input form={"i" + it.id} name="price" defaultValue={(Number(it.price) / 100).toString()} className="narrow" inputMode="decimal" aria-label={`Price of ${it.name}`} /></td>
                <td>
                  <label className="check" style={{ margin: 0 }}>
                    <input form={"i" + it.id} type="checkbox" name="available" defaultChecked={it.is_available} />
                    {it.is_available ? "Yes" : <span className="flag">Sold out</span>}
                  </label>
                </td>
                <td>
                  <form id={"i" + it.id} action={quickSave} className="row-actions">
                    <input type="hidden" name="id" value={it.id} />
                    <input type="hidden" name="back" value={here} />
                    <button type="submit" className="btn-quiet btn-sm">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
