import { requirePerm } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { branches, pickedOf } from "@/lib/branch";

// A shop's catalog as the file the importer reads: one row per line (a simple
// product, or one variant), in the importer's own columns. With ?template=1
// it is the header alone. Edited and imported again, it changes the products
// it names; Opening stock is what is on hand now, and the importer only uses
// it for a line that has never moved.
// Stock and reorder levels are each branch's (multi-branch): the file has
// those of the branch picked on the import page, where it is downloaded, and
// the import puts them back at the branch picked. With All branches of two or
// more it has none, so it imports again with no branch and moves no stock.

export const dynamic = "force-dynamic";

// a product in a sub category (0145) is under its parent in Category and its own in Sub category, as the import reads them
const HEAD = [
  "Name", "Category", "Sub category", "Brand", "Supplier", "Supplier code", "Option 1", "Value 1", "Option 2", "Value 2", "Option 3", "Value 3",
  "SKU", "Barcode", "Price", "Cost", "Tax", "Reorder at", "Order quantity", "Opening stock", "Sold by", "Count stock",
];
// how a product is sold, in the words the importer reads back (0131)
const way = (r: Row) => (r.open_price ? "at the sale" : r.sold_by === "weight" ? "kilo" : "each");
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rupees = (cents: string | null) => (cents === null ? "" : (Number(cents) / 100).toFixed(2));
const units = (q: number | null) => (q === null ? "" : String(q / 1000));

type Row = {
  name: string; category: string | null; sub_category: string | null; brand: string | null; supplier: string | null; supplier_code: string | null;
  option_names: string[]; option_values: string[] | null; sku: string | null; barcode: string | null;
  price: string; cost: string | null; tax: string | null; reorder_point: number | null; reorder_qty: number | null; qty: number;
  sold_by: string; open_price: boolean; track_stock: boolean;
};

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requirePerm("items.edit");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // a redirect to the sign-in page
    return new Response("You are not allowed to download the catalog.", { status: 403 });
  }
  if (ctx.mode !== "retail") return new Response("Not found", { status: 404 });
  const template = new URL(req.url).searchParams.get("template") === "1";
  // the Cost column is filled only for someone who may see cost; left empty, an import keeps the cost a line has
  const costs = template || (await readTenant(ctx.tenantId, async (c) => (await c.query(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId])).rows[0].ok as boolean));
  const { rows, levels, branch } = template
    ? { rows: [] as Row[], levels: true, branch: null }
    : await readTenant(ctx.tenantId, async (c) => {
        const all = await branches(c, ctx.tenantId);
        const picked = await pickedOf(all);
        // one branch: all of it, as before branches; several: the one picked, or none with All branches
        const store = all.length > 1 ? (picked?.id ?? null) : null;
        const levels = all.length < 2 || picked !== null;
        const rows = (
          await c.query(
            `select i.name, coalesce(pc.name, c.name) as category, case when pc.id is not null then c.name end as sub_category, i.brand, s.name as supplier, i.supplier_code, i.option_names, v.option_values,
                    case when v.id is null then i.sku else v.sku end as sku,
                    case when v.id is null then i.barcode else v.barcode end as barcode,
                    coalesce(v.price, i.price) as price, coalesce(v.cost, i.cost) as cost,
                    (select t.name from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id
                      where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null limit 1) as tax,
                    l.reorder_point, l.reorder_qty,
                    coalesce(l.qty, case when v.id is null and $2::uuid is null then i.stock_qty end, 0)::int as qty,
                    i.sold_by, i.open_price, i.track_stock
               from items i
               left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
               left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
               left join categories pc on pc.tenant_id = c.tenant_id and pc.id = c.parent_id
               left join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id and s.deleted_at is null
               left join lateral (select sum(x.qty)::int as qty, max(x.reorder_point) as reorder_point, max(x.reorder_qty) as reorder_qty
                                    from stock_levels x
                                   where x.tenant_id = i.tenant_id and x.item_id = i.id and x.variant_id is not distinct from v.id
                                     and ($2::uuid is null or x.store_id = $2)) l on true
              where i.tenant_id = $1 and i.deleted_at is null
              order by lower(i.name), v.created_at, v.name`,
            [ctx.tenantId, store],
          )
        ).rows as Row[];
        return { rows, levels, branch: all.length > 1 ? picked : null };
      });
  // the file of one branch of several says which in its name
  const slug = branch?.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const file = template ? "products-template" : slug ? `products-${slug}` : "products";
  const lines = [HEAD.map(cell).join(",")];
  for (const r of rows) {
    const vals = r.option_values ?? [];
    const pair = (n: number) => (vals[n] ? [r.option_names[n] ?? "", vals[n]] : ["", ""]);
    lines.push(
      [r.name, r.category, r.sub_category, r.brand, r.supplier, r.supplier_code, ...pair(0), ...pair(1), ...pair(2), r.sku, r.barcode,
        r.open_price ? "" : rupees(r.price), costs ? rupees(r.cost) : "", r.tax,
        ...(levels ? [units(r.reorder_point), units(r.reorder_qty), units(Math.max(0, r.qty))] : ["", "", ""]),
        way(r), r.track_stock ? "yes" : "no"]
        .map(cell)
        .join(","),
    );
  }
  // the mark at the start tells a spreadsheet the file is UTF-8, so accents survive
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file}.csv"`,
      "cache-control": "no-store",
    },
  });
}
