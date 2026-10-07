import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, backTo, on, Refused, text, UUID, uuid } from "@/lib/action";
import { parseRs } from "@/lib/money";
import { fmtQty } from "@/lib/report";
import { setItemTax } from "@/lib/saves";
import { money, withDefaults } from "@/lib/settings";
import { Flash, one, PageHead, type Search, startKey, startOf } from "../ui";
import type { AddonGroup, Tax } from "./editor";
import { type Item, ItemsTable } from "./table";

const PATH = "/backoffice/items";

type ItemRow = {
  id: string;
  name: string;
  price: string;
  is_available: boolean;
  category_id: string | null;
  cat_name: string | null;
  cat_color: string | null;
  cat_order: number | null;
  sku: string | null;
  barcode: string | null;
  track_stock: boolean;
  tracked: boolean;
  stock_qty: string;
  tax: string | null;
  tax_id: string | null;
  group_ids: string[] | null;
};

// Price and availability are what change day to day, so they are edited in
// the list; everything else is in the item's panel.
async function quickSave(f: FormData) {
  "use server";
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
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

// Several items at once: off sale when the kitchen runs out of a whole
// section, or back on sale the next morning. Nothing else about them changes.
async function bulkSave(f: FormData) {
  "use server";
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
    const ids = [...new Set(f.getAll("id").map(String))].filter((v) => UUID.test(v)).slice(0, 2000);
    if (ids.length === 0) throw new Refused("Tick the items first.");
    const available = on(f, "available");
    const done = await c.query(`update items set is_available = $3 where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null and is_available <> $3`, [
      ctx.tenantId,
      ids,
      available,
    ]);
    const n = done.rowCount ?? 0;
    if (n === 0) return available ? "Those items were already on sale." : "Those items were already sold out.";
    return `${n} ${n === 1 ? "item" : "items"} ${available ? "back on sale" : "marked sold out"}. The tills have it after their next sync.`;
  });
}

// One item, from its panel: what it is called, what it costs, which tax it
// carries, which add-on groups the till offers with it. Saved, it goes back
// to the list as it was; refused, the panel is opened again with the reason.
async function saveItem(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  const editing = UUID.test(id);
  const back = backTo(f, PATH);
  const reopened = `${back}${back.includes("?") ? "&" : "?"}edit=${editing ? id : "new"}`;
  await act(
    "items.edit",
    back,
    async (c, ctx) => {
      if (editing && f.get("remove") === "1") {
        await c.query(`update items set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
        return "Item removed. Receipts that sold it keep its name.";
      }
      const name = text(f, "name", 80);
      const price = parseRs(String(f.get("price") ?? ""));
      const category = String(f.get("category") ?? "");
      const tax = String(f.get("tax") ?? "");
      if (!name) throw new Refused("Give the item a name.");
      if (price === null) throw new Refused("The price is not a number.");
      if (!UUID.test(tax)) throw new Refused("Pick the tax this item carries.");
      const groups = f.getAll("group").map(String).filter((g) => UUID.test(g));
      // what a scanner reads off the packet; two items with the same one would leave the till guessing
      const barcode = text(f, "barcode", 64).replace(/\s+/g, "") || null;
      if (barcode) {
        const taken = await c.query(`select name from items where tenant_id = $1 and barcode = $2 and deleted_at is null and ($3::uuid is null or id <> $3::uuid) limit 1`, [
          ctx.tenantId,
          barcode,
          editing ? id : null,
        ]);
        if (taken.rowCount) throw new Refused(`${taken.rows[0].name} already has that barcode.`);
      }
      let item = id;
      if (editing) {
        await c.query(
          `update items set name = $3, price = $4, category_id = $5, is_available = $6, track_stock = $7, barcode = $8
            where tenant_id = $1 and id = $2 and deleted_at is null`,
          [ctx.tenantId, id, name, price, UUID.test(category) ? category : null, on(f, "available"), on(f, "track_stock"), barcode],
        );
      } else {
        const r = await c.query(
          `insert into items (tenant_id, category_id, name, price, is_available, track_stock, barcode) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [ctx.tenantId, UUID.test(category) ? category : null, name, price, on(f, "available"), on(f, "track_stock"), barcode],
        );
        item = r.rows[0].id as string;
      }
      // refused, everything above is undone with it: the item is as it was
      if (!(await setItemTax(c, ctx.tenantId, item, tax))) throw new Refused("That tax is no longer there. Pick the tax this item carries.");
      await c.query(`update item_modifier_groups set deleted_at = now() where tenant_id = $1 and item_id = $2 and not (group_id = any($3::uuid[])) and deleted_at is null`, [ctx.tenantId, item, groups]);
      await c.query(
        `insert into item_modifier_groups (tenant_id, item_id, group_id)
           select $1, $2, g.id from modifier_groups g where g.tenant_id = $1 and g.deleted_at is null and g.id = any($3::uuid[])
         on conflict (item_id, group_id) do update set deleted_at = null`,
        [ctx.tenantId, item, groups],
      );
      return `${name} saved.`;
    },
    reopened,
  );
}

export default async function ItemsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  // Every item comes down once, with what its panel needs, and so do the
  // choices the panel offers: the table finds, filters and sorts in the
  // browser, and the panel opens without asking the server for anything.
  const d = await readTenant(ctx.tenantId, async (c) => ({
    // the settings and the three lists in one trip
    menu: (
      await c.query(
        `select (select data from pos_settings where tenant_id = $1 and deleted_at is null) as settings,
                coalesce((select json_agg(json_build_object('id', k.id, 'name', k.name) order by k.sort_order, k.name)
                            from categories k where k.tenant_id = $1 and k.deleted_at is null), '[]'::json) as cats,
                coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name, 'rate_bp', t.rate_bp, 'type', t.type, 'is_default', t.is_default)
                                          order by t.is_default desc, t.rate_bp desc, t.name)
                            from taxes t where t.tenant_id = $1 and t.deleted_at is null), '[]'::json) as taxes,
                coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'n',
                                            (select count(*) from modifiers m where m.tenant_id = g.tenant_id and m.group_id = g.id and m.deleted_at is null)) order by g.name)
                            from modifier_groups g where g.tenant_id = $1 and g.deleted_at is null), '[]'::json) as groups`,
        [ctx.tenantId],
      )
    ).rows[0] as { settings: unknown; cats: { id: string; name: string }[]; taxes: Tax[]; groups: AddonGroup[] },
    items: (
      await c.query(
        `select i.id, i.name, i.price, i.is_available, i.category_id, i.sku, i.barcode, i.track_stock,
                c.name as cat_name, c.color as cat_color, c.sort_order as cat_order,
                (i.track_stock or coalesce(c.is_stock, false)) as tracked, coalesce(i.stock_qty, 0) as stock_qty,
                (select string_agg(t.name, ', ') from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id
                  where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null) as tax,
                (select it.tax_id from item_taxes it where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null limit 1) as tax_id,
                array(select g.group_id from item_modifier_groups g where g.tenant_id = i.tenant_id and g.item_id = i.id and g.deleted_at is null) as group_ids
           from items i left join categories c on c.id = i.category_id and c.tenant_id = i.tenant_id
          where i.deleted_at is null and i.tenant_id = $1
          order by c.sort_order nulls last, c.name nulls last, i.name`,
        [ctx.tenantId],
      )
    ).rows as ItemRow[],
  }));
  const decimals = withDefaults(d.menu.settings).decimals;
  const items: Item[] = d.items.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price),
    shown: money(Number(r.price), decimals),
    is_available: r.is_available,
    cat_id: r.category_id,
    cat: r.cat_name,
    cat_color: r.cat_color,
    cat_order: r.cat_order ?? Number.MAX_SAFE_INTEGER,
    sku: r.sku?.trim() || null,
    barcode: r.barcode?.trim() || null,
    tax: r.tax,
    addons: r.group_ids?.length ?? 0,
    stock: r.tracked ? Number(r.stock_qty) : null,
    stock_shown: fmtQty(Number(r.stock_qty)),
    tax_id: r.tax_id,
    group_ids: r.group_ids ?? [],
    own_stock: r.track_stock,
  }));
  // The Categories page and the search link here with ?category= and
  // ?edit=<item>; `cat` is the older spelling of the first.
  const start = startOf({ ...sp, category: one(sp.category) || one(sp.cat) }, "q", "category", "status", "sort", "open", "edit");
  return (
    <div>
      <PageHead
        title={ctx.mode === "retail" ? "Products" : "Items"}
        lede={
          ctx.mode === "retail"
            ? "What the till sells. Find a product, change its price or take it off sale in the list; tap its name for the rest: its tax, category and barcode."
            : "What the till sells. Find an item, change its price or take it off sale in the list; tap its name for the rest: its tax, add-ons, category and barcode."
        }
      />
      {/* a save the panel was refused says why in the panel, which is open again */}
      {!(one(sp.err) && (start.edit === "new" || items.some((i) => i.id === start.edit))) && <Flash sp={sp} />}
      {/* Keyed by what the address asks for: arriving from the search or the
          Categories page with another ?category= starts the table again from it. */}
      <ItemsTable
        key={startKey(sp, start)}
        items={items}
        cats={d.menu.cats}
        taxes={d.menu.taxes}
        groups={d.menu.groups}
        start={start}
        problem={one(sp.err)}
        quickSave={quickSave}
        bulkSave={bulkSave}
        saveItem={saveItem}
      />
    </div>
  );
}
