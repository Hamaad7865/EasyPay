import Link from "next/link";
import { Plus, UtensilsCrossed } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, on, Refused, UUID, uuid } from "@/lib/action";
import { parseRs } from "@/lib/money";
import { fmtQty } from "@/lib/report";
import { loadSettings, money } from "@/lib/settings";
import { Empty, Flash, one, PageHead, type Search } from "../ui";
import { type Item, ItemsTable } from "./table";

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
  tracked: boolean;
  stock_qty: string;
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
  const ctx = await tenantContext();
  // Every item comes down once; the table finds, filters and sorts them in
  // the browser, as you type.
  const d = await withTenant(ctx.tenantId, async (c) => ({
    settings: await loadSettings(c, ctx.tenantId),
    cats: (
      await c.query(`select id, name from categories where deleted_at is null and tenant_id = $1 order by sort_order, name`, [ctx.tenantId])
    ).rows as { id: string; name: string }[],
    items: (
      await c.query(
        `select i.id, i.name, i.price, i.is_available, i.category_id, i.sku, i.barcode,
                c.name as cat_name, c.color as cat_color, c.sort_order as cat_order,
                (i.track_stock or coalesce(c.is_stock, false)) as tracked, coalesce(i.stock_qty, 0) as stock_qty,
                (select string_agg(t.name, ', ') from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id
                  where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null) as tax,
                (select count(*)::int from item_modifier_groups g where g.tenant_id = i.tenant_id and g.item_id = i.id and g.deleted_at is null) as addons
           from items i left join categories c on c.id = i.category_id and c.tenant_id = i.tenant_id
          where i.deleted_at is null and i.tenant_id = $1
          order by c.sort_order nulls last, c.name nulls last, i.name`,
        [ctx.tenantId],
      )
    ).rows as ItemRow[],
  }));
  const items: Item[] = d.items.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price),
    shown: money(Number(r.price), d.settings.decimals),
    is_available: r.is_available,
    cat_id: r.category_id,
    cat: r.cat_name,
    cat_color: r.cat_color,
    cat_order: r.cat_order ?? Number.MAX_SAFE_INTEGER,
    sku: r.sku?.trim() || null,
    barcode: r.barcode?.trim() || null,
    tax: r.tax,
    addons: r.addons,
    stock: r.tracked ? Number(r.stock_qty) : null,
    stock_shown: fmtQty(Number(r.stock_qty)),
  }));
  // the Categories page and the search link here with ?category=; `cat` is its older spelling
  const cat = one(sp.category) || one(sp.cat);
  const open = one(sp.open);
  return (
    <div>
      <PageHead title="Items" lede="What the till sells. Find an item, change its price or take it off sale here; open an item for its tax, add-ons and category.">
        <Link href="/backoffice/items/edit" className="btn">
          <Plus aria-hidden="true" />
          Add item
        </Link>
      </PageHead>
      <Flash sp={sp} />
      {items.length === 0 ? (
        <Empty icon={UtensilsCrossed} title="No items here yet">
          <Link href="/backoffice/items/edit">Add the first one</Link>
        </Empty>
      ) : (
        <ItemsTable
          items={items}
          cats={d.cats}
          start={{ cat: UUID.test(cat) || cat === "none" ? cat : "", q: one(sp.q).trim().slice(0, 60), status: one(sp.status), sort: one(sp.sort), open: UUID.test(open) ? open : "" }}
          quickSave={quickSave}
        />
      )}
    </div>
  );
}
