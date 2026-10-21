import Link from "next/link";
import { Tags } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, backTo, int, on, Refused, text, UUID, uuid } from "@/lib/action";
import { toHex } from "@/lib/colour";
import { loadSettings } from "@/lib/settings";
import { asNature, onMra } from "@/lib/mra";
import { Card, Empty, Flash, PageHead, type Search, startKey, startOf } from "../ui";
import { CategoriesTable, type Category } from "./table";
import { Submit } from "../busy";

const PATH = "/backoffice/categories";
const HEX = /^#[0-9a-f]{6}$/i;
// what a category with no colour of its own is painted with
const PLAIN = "#3f8443";

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
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
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
    // a Premium MRA client says whether a category's items are goods or services (0116)
    if (onMra(ctx.mra)) {
      await c.query(`update categories set mra_nature = $3 where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id, asNature(f.get("mra_nature"))]);
    }
    if (ctx.mode === "retail") {
      // a shop's form has no printers and no Counted tick: both are left as they are
      await c.query(
        `update categories set name = $3, color = $4, sort_order = $5 where tenant_id = $1 and id = $2 and deleted_at is null`,
        [ctx.tenantId, id, name, HEX.test(color) ? color : null, int(f, "sort_order", 0, 999, 0)],
      );
      return `${name} saved.`;
    }
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

type Row = { id: string; name: string; color: string | null; sort_order: number; is_stock: boolean; printer_ids: string[]; items: number; mra_nature: string | null };

export default async function CategoriesPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => ({
    rows: (
      await c.query(
        `select c.id, c.name, c.color, c.sort_order, c.is_stock, c.printer_ids, c.mra_nature,
                (select count(*)::int from items i where i.category_id = c.id and i.tenant_id = c.tenant_id and i.deleted_at is null) as items
           from categories c where c.deleted_at is null and c.tenant_id = $1 order by c.sort_order, c.name`,
        [ctx.tenantId],
      )
    ).rows as Row[],
    printers: (
      // a kitchen screen is ticked like a printer and named as what it is; one
      // that shows everything goes by no ticks, so it is not offered
      await c.query(
        `select id, case when kind = 'screen' then name || ' (screen)' else name end as name
           from printers where tenant_id = $1 and deleted_at is null and not (kind = 'screen' and all_items) and kind <> 'display' order by sort_order, name`,
        [ctx.tenantId],
      )
    ).rows as { id: string; name: string }[],
    onePrinter: (await loadSettings(c, ctx.tenantId)).onePrinter,
    // a kitchen screen set to show everything takes every category's items
    everything: Boolean(
      (await c.query(`select exists (select 1 from printers where tenant_id = $1 and deleted_at is null and is_active and kind = 'screen' and all_items) as e`, [ctx.tenantId])).rows[0]?.e,
    ),
    nature: onMra(ctx.mra) ? (((await c.query(`select mra_nature from tenants where id = $1`, [ctx.tenantId])).rows[0]?.mra_nature as string | null) ?? "") : undefined,
  }));
  const rows: Category[] = d.rows.map((r) => ({
    id: r.id,
    name: r.name,
    hex: toHex(r.color) ?? PLAIN,
    has_color: Boolean(r.color),
    sort_order: r.sort_order,
    is_stock: r.is_stock,
    printer_ids: r.printer_ids ?? [],
    items: r.items,
    mra_nature: r.mra_nature,
  }));
  const start = startOf(sp, "q", "sort", "open");
  // Categories whose items reach nobody in the kitchen: no printer and no
  // kitchen screen ticked, and nothing that takes everything. A category added
  // that way was "sent to kitchen" on the till and never made.
  const known = new Set(d.printers.map((p) => p.id));
  const nowhere =
    ctx.mode === "restaurant" && !d.onePrinter && !d.everything ? rows.filter((r) => r.items > 0 && !r.printer_ids.some((id) => known.has(id))) : [];
  return (
    <div>
      <PageHead
        title="Categories"
        lede={
          ctx.mode === "retail"
            ? "The groups of the catalog, shown above the products on the till's sell screen. The sequence is their order, and the colour is the colour of the group and of its products."
            : "The groups of the menu, shown above the items on the till's order screen. The sequence is their order, the colour is the colour of the group and of its items, and the printers are where a category's items come out when an order is sent (and its stations on the kitchen display)."
        }
      />
      <Flash sp={sp} />
      {nowhere.length > 0 && (
        <div className="note warn">
          {nowhere.length === 1 ? "One category sends its" : `${nowhere.length} categories send their`} items to no printer and no kitchen screen:{" "}
          {nowhere.map((r) => r.name).join(", ")}. When they are ordered, nobody in the kitchen gets them. Open {nowhere.length === 1 ? "it" : "each"} and tick
          where {nowhere.length === 1 ? "its" : "their"} items are made.
        </div>
      )}
      <Card title="Add a category">
        <form action={addCategory} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name" required maxLength={40} style={{ minWidth: 260 }} />
          <input type="color" name="color" defaultValue={PLAIN} aria-label="Colour on the till" />
          <Submit>Add</Submit>
        </form>
      </Card>
      {rows.length === 0 ? (
        <Empty icon={Tags} title="No categories yet">Add the first one above, for example Starters or Drinks.</Empty>
      ) : (
        <CategoriesTable key={startKey(sp, start)} rows={rows} printers={d.printers} start={start} save={saveCategory} mode={ctx.mode} mraBusiness={d.nature} />
      )}
      {ctx.mode === "restaurant" && d.printers.length === 0 && (
        <p className="muted">
          To send orders to a kitchen or bar printer, add it under <Link href="/backoffice/printers">Printers</Link> first.
        </p>
      )}
      {ctx.mode === "restaurant" && d.onePrinter && (
        <p className="muted">
          This restaurant prints everything on one printer, so the printers ticked on a category are not used for now. That is set under{" "}
          <Link href="/backoffice/printers">Printers</Link>.
        </p>
      )}
      {ctx.mode === "restaurant" && (
        <p className="muted">A counted category has its items&apos; quantities under <Link href="/backoffice/stock">Stock</Link>: each sale takes from them.</p>
      )}
    </div>
  );
}
