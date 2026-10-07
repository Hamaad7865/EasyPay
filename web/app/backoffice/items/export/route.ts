import { requirePerm } from "@/lib/tenant";
import { readTenant } from "@/lib/db";

// A shop's catalog as the file the importer reads: one row per line (a simple
// product, or one variant), in the importer's own columns. With ?template=1
// it is the header alone. Edited and imported again, it changes the products
// it names; the last column is what is on hand now, and the importer only
// uses it for a line that has never moved.

export const dynamic = "force-dynamic";

const HEAD = [
  "Name", "Category", "Brand", "Supplier", "Supplier code", "Option 1", "Value 1", "Option 2", "Value 2", "Option 3", "Value 3",
  "SKU", "Barcode", "Price", "Cost", "Tax", "Reorder at", "Order quantity", "Opening stock",
];
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rupees = (cents: string | null) => (cents === null ? "" : (Number(cents) / 100).toFixed(2));
const units = (q: number | null) => (q === null ? "" : String(q / 1000));

type Row = {
  name: string; category: string | null; brand: string | null; supplier: string | null; supplier_code: string | null;
  option_names: string[]; option_values: string[] | null; sku: string | null; barcode: string | null;
  price: string; cost: string | null; tax: string | null; reorder_point: number | null; reorder_qty: number | null; qty: number;
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
  const rows = template
    ? []
    : await readTenant(ctx.tenantId, async (c) =>
        (
          await c.query(
            `select i.name, c.name as category, i.brand, s.name as supplier, i.supplier_code, i.option_names, v.option_values,
                    case when v.id is null then i.sku else v.sku end as sku,
                    case when v.id is null then i.barcode else v.barcode end as barcode,
                    coalesce(v.price, i.price) as price, coalesce(v.cost, i.cost) as cost,
                    (select t.name from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id
                      where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null limit 1) as tax,
                    l.reorder_point, l.reorder_qty,
                    coalesce(l.qty, case when v.id is null then i.stock_qty end, 0)::int as qty
               from items i
               left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
               left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
               left join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id and s.deleted_at is null
               left join lateral (select sum(x.qty)::int as qty, max(x.reorder_point) as reorder_point, max(x.reorder_qty) as reorder_qty
                                    from stock_levels x
                                   where x.tenant_id = i.tenant_id and x.item_id = i.id and x.variant_id is not distinct from v.id) l on true
              where i.tenant_id = $1 and i.deleted_at is null
              order by lower(i.name), v.created_at, v.name`,
            [ctx.tenantId],
          )
        ).rows as Row[],
      );
  const lines = [HEAD.map(cell).join(",")];
  for (const r of rows) {
    const vals = r.option_values ?? [];
    const pair = (n: number) => (vals[n] ? [r.option_names[n] ?? "", vals[n]] : ["", ""]);
    lines.push(
      [r.name, r.category, r.brand, r.supplier, r.supplier_code, ...pair(0), ...pair(1), ...pair(2), r.sku, r.barcode,
        rupees(r.price), costs ? rupees(r.cost) : "", r.tax, units(r.reorder_point), units(r.reorder_qty), units(Math.max(0, r.qty))]
        .map(cell)
        .join(","),
    );
  }
  // the mark at the start tells a spreadsheet the file is UTF-8, so accents survive
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${template ? "products-template" : "products"}.csv"`,
      "cache-control": "no-store",
    },
  });
}
