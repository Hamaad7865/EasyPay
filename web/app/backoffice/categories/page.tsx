import Link from "next/link";
import { Tags } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, int, on, Refused, text, UUID, uuid } from "@/lib/action";
import { toHex } from "@/lib/colour";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";

const PATH = "/backoffice/categories";
const HEX = /^#[0-9a-f]{6}$/i;

async function addCategory(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const name = text(f, "name", 40);
    const color = String(f.get("color") ?? "");
    if (!name) throw new Refused("Give the category a name.");
    await c.query(
      `insert into categories (tenant_id, name, color, sort_order)
       values ($1, $2, $3, (select coalesce(max(sort_order), -1) + 1 from categories where tenant_id = $1))`,
      [ctx.tenantId, name, HEX.test(color) ? color : null],
    );
    return `${name} added.`;
  });
}

// The colour is what the till paints the category's button with; the
// sequence is the order of the buttons; the printers are where its items go
// when an order is sent to the kitchen.
async function saveCategory(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      const n = await c.query(`select count(*)::int as n from items where tenant_id = $1 and category_id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      if (n.rows[0].n > 0) throw new Refused(`This category still has ${n.rows[0].n} items. Move or remove them first.`);
      await c.query(`update categories set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      return "Category removed.";
    }
    const name = text(f, "name", 40);
    const color = String(f.get("color") ?? "");
    if (!name) throw new Refused("A category needs a name.");
    const printers = f.getAll("printer").map(String).filter((p) => UUID.test(p));
    await c.query(
      `update categories set name = $3, color = $4, sort_order = $5, is_stock = $6,
              printer_ids = (select coalesce(array_agg(p.id), '{}') from printers p where p.tenant_id = $1 and p.deleted_at is null and p.id = any($7::uuid[]))
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id, name, HEX.test(color) ? color : null, int(f, "sort_order", 0, 999, 0), on(f, "is_stock"), printers],
    );
    return `${name} saved.`;
  });
}

type Row = { id: string; name: string; color: string | null; sort_order: number; is_stock: boolean; printer_ids: string[]; items: number };

export default async function CategoriesPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => ({
    rows: (
      await c.query(
        `select c.id, c.name, c.color, c.sort_order, c.is_stock, c.printer_ids,
                (select count(*)::int from items i where i.category_id = c.id and i.tenant_id = c.tenant_id and i.deleted_at is null) as items
           from categories c where c.deleted_at is null and c.tenant_id = $1 order by c.sort_order, c.name`,
        [ctx.tenantId],
      )
    ).rows as Row[],
    printers: (
      await c.query(`select id, name from printers where tenant_id = $1 and deleted_at is null order by sort_order, name`, [ctx.tenantId])
    ).rows as { id: string; name: string }[],
  }));
  return (
    <div>
      <PageHead
        title="Categories"
        lede="The groups of the menu, shown above the items on the till's order screen. The sequence is their order, the colour is the colour of the group and of its items, and the printers are where a category's items come out when an order is sent (and its stations on the kitchen display)."
      />
      <Flash sp={sp} />
      {d.rows.length === 0 ? (
        <Empty icon={Tags} title="No categories yet">Add the first one below, for example Starters or Drinks.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Sequence</th>
                <th>Category</th>
                <th>Colour</th>
                <th>Prints on</th>
                <th>Stock</th>
                <th className="num">Items</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id}>
                  <td><input form={"c" + r.id} name="sort_order" type="number" min={0} max={999} defaultValue={r.sort_order} className="narrow" aria-label="Sequence" /></td>
                  <td><input form={"c" + r.id} name="name" defaultValue={r.name} required maxLength={40} aria-label="Name" /></td>
                  <td><input form={"c" + r.id} type="color" name="color" defaultValue={toHex(r.color) ?? "#1740e0"} aria-label={`Colour for ${r.name}`} /></td>
                  <td>
                    {d.printers.length === 0 ? (
                      <span className="muted">No printers</span>
                    ) : (
                      d.printers.map((p) => (
                        <label key={p.id} className="check" style={{ margin: "2px 12px 2px 0", display: "inline-flex" }}>
                          <input form={"c" + r.id} type="checkbox" name="printer" value={p.id} defaultChecked={r.printer_ids.includes(p.id)} />
                          {p.name}
                        </label>
                      ))
                    )}
                  </td>
                  <td>
                    <label className="check" style={{ margin: 0 }}>
                      <input form={"c" + r.id} type="checkbox" name="is_stock" defaultChecked={r.is_stock} />
                      Counted
                    </label>
                  </td>
                  <td className="num"><Link href={`/backoffice/items?category=${r.id}`}>{r.items}</Link></td>
                  <td>
                    <form id={"c" + r.id} action={saveCategory} className="row-actions">
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="btn-quiet btn-sm">Save</button>
                      <button type="submit" name="remove" value="1" className="btn-link danger">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Card title="Add a category">
        <form action={addCategory} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name" required maxLength={40} style={{ minWidth: 260 }} />
          <input type="color" name="color" defaultValue="#1740e0" aria-label="Colour on the till" />
          <button type="submit">Add</button>
        </form>
      </Card>
      {d.printers.length === 0 && (
        <p className="muted">
          To send orders to a kitchen or bar printer, add it under <Link href="/backoffice/printers">Printers</Link> first.
        </p>
      )}
      <p className="muted">A counted category has its items&apos; quantities under <Link href="/backoffice/stock">Stock</Link>: each sale takes from them.</p>
    </div>
  );
}
