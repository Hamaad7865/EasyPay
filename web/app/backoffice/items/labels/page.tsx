import Link from "next/link";
import { Barcode } from "lucide-react";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { Empty, Flash, one, PageHead, type Search } from "../../ui";
import { type LabelLine, LabelPicker } from "./picker";

// Barcode labels for a shop's goods: for the ones that came with no maker's
// barcode, and for anything that wants its price on it. A line is a product,
// or one variant of it. A line with no barcode is given one of EasyPay's
// here (assign_barcodes, migration 0070) rather than through a detour to the
// product's page.

const PATH = "/backoffice/items/labels";

async function makeBarcodes(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const products = [...new Set(f.getAll("p").map(String).filter((p) => UUID.test(p)))].slice(0, 500);
    if (products.length === 0) throw new Refused("Choose the lines that need a barcode first.");
    // one statement for all of them: each call gives its product's lines their numbers
    const r = await c.query(
      `select coalesce(sum(assign_barcodes($1, i.id)), 0)::int as n
         from items i where i.tenant_id = $1 and i.id = any($2::uuid[]) and i.deleted_at is null`,
      [ctx.tenantId, products],
    );
    const n = r.rows[0].n as number;
    return n === 0 ? "Those lines already have barcodes." : `${n} ${n === 1 ? "barcode" : "barcodes"} made. Type how many labels of each and print.`;
  });
}

type Row = { product: string; variant: string | null; name: string; variant_name: string | null; price: string; barcode: string | null; qty: number };

export default async function LabelsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const d = await readTenant(ctx.tenantId, async (c) => ({
    s: await loadSettings(c, ctx.tenantId),
    rows: (
      await c.query(
        `select i.id as product, null::uuid as variant, i.name, null::text as variant_name, i.price, i.barcode,
                coalesce(i.stock_qty, 0)::int as qty
           from items i
          where i.tenant_id = $1 and i.deleted_at is null
            and not exists (select 1 from item_variants v where v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null)
         union all
         select i.id, v.id, i.name, v.name, v.price, v.barcode,
                coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = v.tenant_id and l.variant_id = v.id), 0)::int
           from item_variants v join items i on i.tenant_id = v.tenant_id and i.id = v.item_id
          where v.tenant_id = $1 and v.deleted_at is null and i.deleted_at is null
          order by 3, 4`,
        [ctx.tenantId],
      )
    ).rows as Row[],
  }));
  const lines: LabelLine[] = d.rows.map((r) => ({
    key: r.variant ?? r.product,
    product: r.product,
    name: r.name,
    variant: r.variant_name,
    price_shown: money(Number(r.price), d.s.decimals),
    barcode: r.barcode?.trim() || null,
    qty: r.qty,
  }));
  const product = one(sp.product);
  return (
    <div>
      <PageHead
        title="Barcode labels"
        lede="Labels to stick on the goods: the name, the price and a barcode the till reads. Type how many of each, choose a label roll or A4 sheets, and print. In the print window, set the scale to 100% and the margins to none."
      >
        <Link href="/backoffice/settings?tab=barcodes" className="btn btn-quiet">Barcode settings</Link>
        <Link href="/backoffice/items" className="btn btn-quiet">Back to products</Link>
      </PageHead>
      <Flash sp={sp} />
      {lines.length === 0 ? (
        <Empty icon={Barcode} title="No products yet">
          Add them under <Link href="/backoffice/items">Products</Link>, then come back to print their labels.
        </Empty>
      ) : (
        <LabelPicker key={product} lines={lines} preselect={UUID.test(product) ? product : ""} makeBarcodes={makeBarcodes} />
      )}
    </div>
  );
}
