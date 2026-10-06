import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, on, Refused, text, uuid } from "@/lib/action";
import { Card, Flash, PageHead, type Search } from "../ui";

const PATH = "/backoffice/taxes";

function rate(f: FormData): number {
  const v = Number(String(f.get("rate") ?? "").replace(",", "."));
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new Refused("The rate is a percentage between 0 and 100.");
  return Math.round(v * 100);
}

async function addTax(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const name = text(f, "name", 30);
    if (!name) throw new Refused("Give the tax a name.");
    await c.query(`insert into taxes (tenant_id, name, rate_bp, type, is_default) values ($1, $2, $3, $4, false)`, [
      ctx.tenantId,
      name,
      rate(f),
      f.get("type") === "added" ? "added" : "included",
    ]);
    return `${name} added.`;
  });
}

// An item's price either already includes the tax (the guest pays the price
// shown) or has it added on top. The till works the tax out either way.
async function saveTax(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    const name = text(f, "name", 30);
    if (!name) throw new Refused("A tax needs a name.");
    if (on(f, "is_default")) await c.query(`update taxes set is_default = false where tenant_id = $1 and is_default and id <> $2`, [ctx.tenantId, id]);
    await c.query(
      `update taxes set name = $3, rate_bp = $4, type = $5, is_default = is_default or $6 where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id, name, rate(f), f.get("type") === "added" ? "added" : "included", on(f, "is_default")],
    );
    return `${name} saved. Orders already open keep the tax they were rung up with.`;
  });
}

type Row = { id: string; name: string; rate_bp: number; type: string; is_default: boolean; items: number };

export default async function TaxesPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const rows = await readTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select t.id, t.name, t.rate_bp, t.type, t.is_default,
                (select count(*)::int from item_taxes it join items i on i.tenant_id = it.tenant_id and i.id = it.item_id and i.deleted_at is null
                  where it.tenant_id = t.tenant_id and it.tax_id = t.id and it.deleted_at is null) as items
           from taxes t where t.tenant_id = $1 and t.deleted_at is null order by t.is_default desc, t.rate_bp desc, t.name`,
        [ctx.tenantId],
      )
      .then((r) => r.rows as Row[]),
  );
  return (
    <div>
      <PageHead
        title="Taxes"
        lede="Each item carries one of these. VAT at 15% for standard items, Zero rated and Exempt for items that carry no VAT: they are kept apart because the tax report must show them separately."
      />
      <Flash sp={sp} />
      <table>
        <thead>
          <tr>
            <th>Tax</th>
            <th>Rate %</th>
            <th>Menu prices</th>
            <th className="num">Items</th>
            <th>New items</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td><input form={"t" + t.id} name="name" defaultValue={t.name} required maxLength={30} aria-label="Name" /></td>
              <td><input form={"t" + t.id} name="rate" defaultValue={(t.rate_bp / 100).toString()} className="narrow" inputMode="decimal" aria-label="Rate" /></td>
              <td>
                <select form={"t" + t.id} name="type" defaultValue={t.type} aria-label="Menu prices">
                  <option value="included">Include this tax</option>
                  <option value="added">Have it added on top</option>
                </select>
              </td>
              <td className="num">{t.items}</td>
              <td>
                {t.is_default ? <span className="badge blue">Default</span> : (
                  <label className="check" style={{ margin: 0 }}>
                    <input form={"t" + t.id} type="checkbox" name="is_default" />
                    Make default
                  </label>
                )}
              </td>
              <td>
                <form id={"t" + t.id} action={saveTax} className="row-actions">
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className="btn-quiet btn-sm">Save</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Card title="Add a tax">
        <form action={addTax} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name" required maxLength={30} />
          <input name="rate" placeholder="Rate %" required className="narrow" inputMode="decimal" />
          <select name="type" defaultValue="included" aria-label="Menu prices">
            <option value="included">Prices include it</option>
            <option value="added">Added on top</option>
          </select>
          <button type="submit">Add</button>
        </form>
      </Card>
      <p className="muted">Which tax an item carries is set on the item, under <Link href="/backoffice/items">Items</Link>.</p>
    </div>
  );
}
