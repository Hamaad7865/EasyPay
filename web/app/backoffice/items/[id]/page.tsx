import Link from "next/link";
import { notFound } from "next/navigation";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, on, Refused, text, UUID } from "@/lib/action";
import { parseRs } from "@/lib/money";
import { fmtQty } from "@/lib/report";
import { setItemTax } from "@/lib/saves";
import { Card, Flash, PageHead, type Search } from "../../ui";
import { Submit } from "../../busy";
import { PriceFields, type TaxChoice } from "./price-fields";

// A shop's product, on a page of its own: what it is, what it costs and sells
// for, who supplies it and when to reorder it, and its variants (sizes,
// colours) with a barcode, a SKU, a price and a cost each. A restaurant's
// item is edited in a panel over the list and never comes here.
//
// The rules that protect the catalog are the database's (migration 0070): a
// barcode and a SKU belong to one product or variant, variants are made from
// the option values, a line with stock is not removed. This page asks, and
// says in words what the database answered.

const PATH = "/backoffice/items";

const WHY: Record<string, string> = {
  "barcode-taken": "Another product or variant already has that barcode.",
  "sku-taken": "Another product or variant already has that SKU.",
  "has-stock": "There is still stock. Bring it to zero under Stock first.",
  "bad-options": "Give each option a name and at least one value, with nothing repeated. A product that has variants keeps the number of options it has.",
  "too-many-variants": "That would make more than 200 lines for one product.",
  "unknown-variant": "That line is no longer there. Reload the page.",
  "unknown-item": "That product is no longer there.",
};
// runs a change; a rule the database refuses it for becomes a sentence
async function ruled<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const why = e instanceof Error ? WHY[e.message] : undefined;
    if (why) throw new Refused(why);
    throw e;
  }
}

// a quantity typed in units, kept in thousandths; empty is "none set"
function units(f: FormData, k: string): number | null {
  const raw = String(f.get(k) ?? "").trim().replace(",", ".");
  if (raw === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1_000_000) throw new Refused("A reorder quantity is not a number.");
  return Math.round(v * 1000);
}
const code = (f: FormData, k: string, max: number) => text(f, k, max).replace(/\s+/g, "") || null;

async function saveProduct(f: FormData) {
  "use server";
  const given = String(f.get("id") ?? "");
  const editing = UUID.test(given);
  // a new product is given its id here, so the page to return to is known
  const id = editing ? given : crypto.randomUUID();
  await act(
    "items.edit",
    `${PATH}/${id}`,
    async (c, ctx) => {
      const name = text(f, "name", 80);
      const price = parseRs(String(f.get("price") ?? ""));
      const costText = String(f.get("cost") ?? "").trim();
      const cost = costText === "" ? null : parseRs(costText);
      const tax = String(f.get("tax") ?? "");
      const category = String(f.get("category") ?? "");
      const supplier = String(f.get("supplier") ?? "");
      if (!name) throw new Refused("Give the product a name.");
      if (price === null) throw new Refused("The selling price is not a number.");
      if (costText !== "" && cost === null) throw new Refused("The cost is not a number.");
      if (!UUID.test(tax)) throw new Refused("Pick the tax this product carries.");
      const reorder = units(f, "reorder");
      const orderQty = units(f, "order_qty");
      const row = [
        ctx.tenantId, id, name, price, cost,
        UUID.test(category) ? category : null,
        text(f, "brand", 60) || null,
        UUID.test(supplier) ? supplier : null,
        text(f, "supplier_code", 60) || null,
        on(f, "available"), on(f, "track_stock"),
      ];
      await ruled(async () => {
        if (editing) {
          const done = await c.query(
            `update items set name = $3, price = $4, cost = $5, category_id = $6, brand = $7,
                    supplier_id = (select s.id from suppliers s where s.tenant_id = $1 and s.id = $8 and s.deleted_at is null),
                    supplier_code = $9, is_available = $10, track_stock = $11
              where tenant_id = $1 and id = $2 and deleted_at is null`,
            row,
          );
          if (done.rowCount !== 1) throw new Refused("That product is no longer there.");
        } else {
          await c.query(
            `insert into items (tenant_id, id, name, price, cost, category_id, brand, supplier_id, supplier_code, is_available, track_stock)
             values ($1, $2, $3, $4, $5, $6, $7,
                     (select s.id from suppliers s where s.tenant_id = $1 and s.id = $8 and s.deleted_at is null), $9, $10, $11)`,
            row,
          );
        }
        // a simple product carries its own codes; one with variants has them on its lines
        if (f.has("sku") || f.has("barcode")) {
          await c.query(`update items set sku = $3, barcode = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, text(f, "sku", 60) || null, code(f, "barcode", 64)]);
        }
      });
      if (!(await setItemTax(c, ctx.tenantId, id, tax))) throw new Refused("That tax is no longer there. Pick the tax this product carries.");
      await c.query(`select stock_set_reorder($1, first_store($1), $2, $3, $4)`, [ctx.tenantId, id, reorder, orderQty]);
      return `${name} saved.`;
    },
    `${PATH}/${editing ? id : "new"}`,
  );
}

// Option values are added to: every combination the product does not have yet
// becomes a line. Adding a colour next season makes only that colour's lines.
async function addOptions(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("items.edit", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("Save the product first.");
    const names: string[] = [];
    const values: string[][] = [];
    for (const n of [1, 2, 3]) {
      const name = text(f, `opt${n}`, 30);
      // the values it has, then the ones typed now; one typed again is not a second value
      const seen = new Set<string>();
      const vals = [...String(f.get(`has${n}`) ?? "").split("\n"), ...String(f.get(`val${n}`) ?? "").split(",")]
        .map((v) => v.trim().slice(0, 30))
        .filter((v) => v !== "" && !seen.has(v.toLowerCase()) && Boolean(seen.add(v.toLowerCase())));
      if (!name && vals.length === 0) continue;
      names.push(name);
      values.push(vals);
    }
    if (names.length === 0) throw new Refused("Name an option, for example Size, and give its values.");
    const r = await ruled(() => c.query(`select variants_generate($1, $2, $3, $4::jsonb) as r`, [ctx.tenantId, id, names, JSON.stringify(values)]));
    const { created, existing } = r.rows[0].r as { created: number; existing: number };
    if (created === 0) return "Every line is already there.";
    return `${created} ${created === 1 ? "line" : "lines"} made${existing ? `, ${existing} already there` : ""}. Give them barcodes below, or type the makers' own.`;
  });
}

// The lines of a product, saved together in one statement.
async function saveLines(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("items.edit", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That product is no longer there.");
    const lines = f.getAll("v").map(String).filter((v) => UUID.test(v)).map((v) => {
      const price = parseRs(String(f.get(`price:${v}`) ?? ""));
      const costText = String(f.get(`cost:${v}`) ?? "").trim();
      const cost = costText === "" ? null : parseRs(costText);
      if (price === null || (costText !== "" && cost === null)) throw new Refused("A price or a cost on one of the lines is not a number.");
      return { id: v, barcode: code(f, `barcode:${v}`, 64), sku: text(f, `sku:${v}`, 60) || null, price, cost };
    });
    await ruled(() =>
      c.query(
        `update item_variants v set barcode = x.barcode, sku = x.sku, price = x.price, cost = x.cost
           from jsonb_to_recordset($3::jsonb) as x(id uuid, barcode text, sku text, price bigint, cost bigint)
          where v.tenant_id = $1 and v.item_id = $2 and v.id = x.id and v.deleted_at is null`,
        [ctx.tenantId, id, JSON.stringify(lines)],
      ),
    );
    return lines.length === 1 ? "1 line saved." : `${lines.length} lines saved.`;
  });
}

async function removeLine(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("items.edit", `${PATH}/${id}`, async (c, ctx) => {
    const line = String(f.get("remove") ?? "");
    if (!UUID.test(line)) throw new Refused("That line is no longer there. Reload the page.");
    await ruled(() => c.query(`select variant_archive($1, $2)`, [ctx.tenantId, line]));
    return "Line removed. Receipts that sold it keep its name.";
  });
}

async function makeBarcodes(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("items.edit", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("Save the product first.");
    const r = await ruled(() => c.query(`select assign_barcodes($1, $2) as n`, [ctx.tenantId, id]));
    const n = r.rows[0].n as number;
    return n === 0 ? "Every line already has a barcode." : `${n} ${n === 1 ? "barcode" : "barcodes"} made. Print them as labels to stick on the goods.`;
  });
}

async function removeProduct(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act(
    "items.edit",
    PATH,
    async (c, ctx) => {
      if (!UUID.test(id)) throw new Refused("That product is no longer there.");
      const held = await c.query(`select 1 from stock_levels where tenant_id = $1 and item_id = $2 and qty <> 0 limit 1`, [ctx.tenantId, id]);
      if (held.rowCount) throw new Refused("This product still has stock. Bring it to zero under Stock first, then remove it.");
      await c.query(`update items set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      return "Product removed. Receipts that sold it keep its name.";
    },
    `${PATH}/${id}`,
  );
}

type ItemRow = {
  id: string; name: string; price: string; cost: string | null; category_id: string | null; brand: string | null;
  supplier_id: string | null; supplier_code: string | null; sku: string | null; barcode: string | null;
  is_available: boolean; track_stock: boolean; option_names: string[]; stock_qty: number; tax_id: string | null;
  reorder_point: number | null; reorder_qty: number | null;
};
type VariantRow = { id: string; name: string; barcode: string | null; sku: string | null; price: string; cost: string | null; option_values: string[]; qty: number };

const rupees = (cents: string | number | null) => (cents === null ? "" : (Number(cents) / 100).toString());
const qtyUnits = (q: number | null) => (q === null ? "" : (q / 1000).toString());

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const isNew = id === "new";
  if (!isNew && !UUID.test(id)) notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [item, variants, cats, taxes, suppliers] = await Promise.all([
      isNew
        ? Promise.resolve({ rows: [] as ItemRow[] })
        : c.query(
            `select i.id, i.name, i.price, i.cost, i.category_id, i.brand, i.supplier_id, i.supplier_code, i.sku, i.barcode,
                    i.is_available, i.track_stock, i.option_names, coalesce(i.stock_qty, 0)::int as stock_qty,
                    (select it.tax_id from item_taxes it where it.tenant_id = i.tenant_id and it.item_id = i.id and it.deleted_at is null limit 1) as tax_id,
                    (select l.reorder_point from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id and l.reorder_point is not null limit 1) as reorder_point,
                    (select l.reorder_qty from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id and l.reorder_qty is not null limit 1) as reorder_qty
               from items i where i.tenant_id = $1 and i.id = $2 and i.deleted_at is null`,
            [ctx.tenantId, id],
          ),
      isNew
        ? Promise.resolve({ rows: [] as VariantRow[] })
        : c.query(
            `select v.id, v.name, v.barcode, v.sku, v.price, v.cost, v.option_values,
                    coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = v.tenant_id and l.variant_id = v.id), 0)::int as qty
               from item_variants v
              where v.tenant_id = $1 and v.item_id = $2 and v.deleted_at is null
              order by v.created_at, v.name`,
            [ctx.tenantId, id],
          ),
      c.query(`select id, name from categories where tenant_id = $1 and deleted_at is null order by sort_order, name`, [ctx.tenantId]),
      c.query(`select id, name, rate_bp, type, is_default from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, name`, [ctx.tenantId]),
      c.query(`select id, name from suppliers where tenant_id = $1 and deleted_at is null order by lower(name)`, [ctx.tenantId]),
    ]);
    return {
      item: (item.rows[0] as ItemRow | undefined) ?? null,
      variants: variants.rows as VariantRow[],
      cats: cats.rows as { id: string; name: string }[],
      taxes: taxes.rows as (TaxChoice & { is_default: boolean })[],
      suppliers: suppliers.rows as { id: string; name: string }[],
    };
  });
  if (!isNew && !d.item) notFound();
  const item = d.item;
  const lines = d.variants;
  const hasLines = lines.length > 0;
  const onHand = hasLines ? lines.reduce((a, v) => a + v.qty, 0) : (item?.stock_qty ?? 0);
  // each option with the values its lines already use, in the order they first appear
  const options = [0, 1, 2].map((n) => ({
    name: item?.option_names[n] ?? "",
    values: [...new Set(lines.map((v) => v.option_values[n]).filter((v): v is string => Boolean(v)))],
  }));
  const optionRows = hasLines ? options.filter((o) => o.name !== "") : options;
  const tax = item?.tax_id ?? d.taxes[0]?.id ?? "";
  const missingCodes = hasLines ? lines.filter((v) => !v.barcode).length : item && !item.barcode ? 1 : 0;

  return (
    <div>
      <PageHead
        title={item ? item.name : "New product"}
        lede={
          item
            ? `${hasLines ? `${lines.length} ${lines.length === 1 ? "variant" : "variants"}, ` : ""}${fmtQty(onHand)} on hand.`
            : "What it is, what it costs and sells for, and who supplies it. Sizes and colours are added once it is saved."
        }
      >
        <Link href={PATH} className="btn btn-quiet">Back to products</Link>
        {item && <Link href={`${PATH}/labels?product=${item.id}`} className="btn btn-quiet">Print labels</Link>}
        <Submit form="product">{item ? "Save" : "Save product"}</Submit>
      </PageHead>
      <Flash sp={sp} />
      <div className="grid-2">
        <form id="product" action={saveProduct}>
          {item && <input type="hidden" name="id" value={item.id} />}
          <Card title="General">
            <label className="field">
              Name
              <input name="name" defaultValue={item?.name} required maxLength={80} />
            </label>
            <div className="form-row">
              <label className="field">
                Category
                <select name="category" defaultValue={item?.category_id ?? ""}>
                  <option value="">No category</option>
                  {d.cats.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Brand
                <input name="brand" defaultValue={item?.brand ?? ""} maxLength={60} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" name="available" defaultChecked={item?.is_available ?? true} />
              <span>
                On sale
                <small>Untick to take it off the till without removing it.</small>
              </span>
            </label>
          </Card>
          <Card title="Price">
            <PriceFields cost={rupees(item?.cost ?? null)} price={item ? rupees(item.price) : ""} tax={tax} taxes={d.taxes} />
            {hasLines && <p className="muted" style={{ margin: "12px 0 0" }}>A change here reaches the variants that are at this price or cost. One priced differently keeps its own.</p>}
          </Card>
          <Card title="Stock">
            <div className="form-row">
              <label className="field">
                Supplier
                <select name="supplier" defaultValue={item?.supplier_id ?? ""}>
                  <option value="">No supplier</option>
                  {d.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {d.suppliers.length === 0 && (
                  <span className="help">
                    None yet. Add them under <Link href="/backoffice/suppliers">Suppliers</Link>.
                  </span>
                )}
              </label>
              <label className="field">
                Supplier&apos;s code
                <input name="supplier_code" defaultValue={item?.supplier_code ?? ""} maxLength={60} placeholder="What they call it on an order" />
              </label>
            </div>
            {!hasLines && (
              <div className="form-row">
                <label className="field">
                  Barcode
                  <input name="barcode" defaultValue={item?.barcode ?? ""} maxLength={64} placeholder="Scan it here, or leave empty" autoComplete="off" />
                </label>
                <label className="field">
                  SKU
                  <input name="sku" defaultValue={item?.sku ?? ""} maxLength={60} placeholder="Your own code for it" autoComplete="off" />
                </label>
              </div>
            )}
            <div className="form-row">
              <label className="field">
                Reorder when at or below
                <input name="reorder" defaultValue={qtyUnits(item?.reorder_point ?? null)} inputMode="decimal" placeholder="No level set" />
              </label>
              <label className="field">
                Usual order quantity
                <input name="order_qty" defaultValue={qtyUnits(item?.reorder_qty ?? null)} inputMode="decimal" />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" name="track_stock" defaultChecked={item?.track_stock ?? true} />
              <span>
                Counted in stock
                <small>Untick for a service or a bag fee: it then has no quantity.</small>
              </span>
            </label>
          </Card>
        </form>

        <div>
          <Card
            title="Variants"
            lede={item ? "Sizes, colours or anything else it comes in. Each combination is a line with its own barcode, price, cost and stock." : "Save the product, then add its sizes and colours here."}
          >
            {item && (
              <form action={addOptions}>
                <input type="hidden" name="id" value={item.id} />
                {optionRows.map((o, i) => {
                  const n = (hasLines ? options.indexOf(o) : i) + 1;
                  return (
                    <div key={n} className="form-row" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)" }}>
                      <label className="field">
                        Option {n}
                        <input name={`opt${n}`} defaultValue={o.name} maxLength={30} placeholder={["Size", "Colour", "Material"][n - 1]} />
                      </label>
                      <label className="field">
                        {o.values.length > 0 ? "Add values" : "Values, separated by commas"}
                        <input name={`val${n}`} maxLength={300} placeholder={o.values.length > 0 ? "A new one, or several with commas" : ["S, M, L, XL", "White, Navy", "Cotton, Linen"][n - 1]} autoComplete="off" />
                        <input type="hidden" name={`has${n}`} value={o.values.join("\n")} />
                        {o.values.length > 0 && (
                          <span className="help">
                            Has: {o.values.map((v) => (
                              <span key={v} className="badge" style={{ marginRight: 4 }}>{v}</span>
                            ))}
                          </span>
                        )}
                      </label>
                    </div>
                  );
                })}
                <Submit className="btn-sm">{hasLines ? "Make the missing lines" : "Make the lines"}</Submit>
              </form>
            )}
          </Card>

          {item && hasLines && (
            <Card title={`${lines.length} ${lines.length === 1 ? "line" : "lines"}`} lede="Change a barcode, a SKU, a price or a cost, then save the lines. Quantities change under Stock." flush>
              <form action={saveLines}>
                <input type="hidden" name="id" value={item.id} />
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th>Barcode</th>
                        <th>SKU</th>
                        <th className="num">Price (Rs)</th>
                        <th className="num">Cost (Rs)</th>
                        <th className="num">On hand</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((v) => (
                        <tr key={v.id}>
                          <td className="strong">
                            <input type="hidden" name="v" value={v.id} />
                            {v.name}
                          </td>
                          <td><input name={`barcode:${v.id}`} defaultValue={v.barcode ?? ""} maxLength={64} aria-label={`Barcode of ${v.name}`} autoComplete="off" style={{ width: 150 }} /></td>
                          <td><input name={`sku:${v.id}`} defaultValue={v.sku ?? ""} maxLength={60} aria-label={`SKU of ${v.name}`} autoComplete="off" style={{ width: 120 }} /></td>
                          <td className="num"><input name={`price:${v.id}`} defaultValue={rupees(v.price)} required inputMode="decimal" aria-label={`Price of ${v.name}`} className="narrow" /></td>
                          <td className="num"><input name={`cost:${v.id}`} defaultValue={rupees(v.cost)} inputMode="decimal" aria-label={`Cost of ${v.name}`} className="narrow" /></td>
                          <td className="num strong">{v.qty <= 0 ? <span className="badge red">{fmtQty(v.qty)}</span> : fmtQty(v.qty)}</td>
                          <td>
                            <Submit className="btn-link danger" name="remove" value={v.id} formAction={removeLine} formNoValidate aria-label={`Remove ${v.name}`}>
                              Remove
                            </Submit>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="card-body bo-toolbar" style={{ margin: 0 }}>
                  <Submit className="btn-sm">Save the lines</Submit>
                  {missingCodes > 0 && (
                    <Submit className="btn-sm btn-quiet" formAction={makeBarcodes} formNoValidate>
                      Make barcodes for the {missingCodes === 1 ? "line that has" : `${missingCodes} lines that have`} none
                    </Submit>
                  )}
                </div>
              </form>
            </Card>
          )}

          {item && !hasLines && missingCodes > 0 && (
            <form action={makeBarcodes} className="bo-toolbar">
              <input type="hidden" name="id" value={item.id} />
              <span className="muted">No maker&apos;s barcode on it?</span>
              <Submit className="btn-sm btn-quiet">Make it an EasyPay barcode</Submit>
            </form>
          )}

          {item && (
            <form action={removeProduct} className="open-remove" style={{ marginTop: 16 }}>
              <input type="hidden" name="id" value={item.id} />
              <span className="muted">Removing a product keeps the receipts that sold it. It is refused while there is stock.</span>
              <Submit className="btn-link danger">Remove {item.name}</Submit>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
